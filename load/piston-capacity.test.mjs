import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = readFileSync(new URL('./piston-capacity.js', import.meta.url), 'utf8');
const lock = readFileSync(new URL('../infra/piston/image-inputs.lock.json', import.meta.url), 'utf8');
function harness() {
  const metrics = new Map();
  const sent = [];
  class Metric {
    constructor(name) { this.name = name; metrics.set(name, []); }
    add(value, tags) { metrics.get(this.name).push({ value, tags }); }
  }
  const runtimeList = Object.values(JSON.parse(lock).runtimes);
  let response = { status: 200, timings: { duration: 200 },
    json: () => ({ run: { code: 0, stdout: '42\n', wall_time: 20 } }) };
  const context = vm.createContext({
    http: { get: () => ({ status: 200, json: () => runtimeList }),
      post: (url, payload) => { sent.push({ url, payload: JSON.parse(payload) }); return response; } },
    execution: { scenario: { startTime: Date.now() } },
    fail: message => { throw new Error(message); }, sleep: () => {},
    Counter: Metric, Rate: Metric, Trend: Metric, open: () => lock,
    __VU: 1, __ITER: 0, __ENV: { CAPACITY_SLOTS: '2' },
  });
  const code = source.replace(/^import .*;\n/gm, '').replace('export default function ()', 'function iteration()').replace(/export /g, '');
  const api = vm.runInContext(`${code}\n({options, setup, iteration, handleSummary})`, context);
  return { ...api, context, metrics, sent, respond: value => { response = value; } };
}

test('180-second ramp mixes all five locked runtimes with production job limits', () => {
  const h = harness();
  assert.equal(h.options.scenarios.capacity.startVUs, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.options.scenarios.capacity.stages)), [
    { duration: '30s', target: 1 }, { duration: '45s', target: 10 }, { duration: '30s', target: 10 },
    { duration: '45s', target: 20 }, { duration: '30s', target: 20 },
  ]);
  h.setup();
  for (let i = 0; i < 5; i++) { h.context.__ITER = i; h.iteration(); }
  assert.equal(h.metrics.get('job_requests').length, 5);
  assert.equal(new Set(h.sent.map(item => item.payload.files[0].content)).size, 5);
  for (const { url, payload } of h.sent) {
    assert.equal(url, 'http://piston:2000/api/v2/execute');
    assert.equal(payload.run_timeout, 3000);
    assert.equal(payload.compile_timeout, 10000);
    assert.equal(payload.run_memory_limit, 268435456);
    assert.equal(payload.compile_memory_limit, 536870912);
    assert.ok(Object.values(JSON.parse(lock).runtimes).some(item => item.language === payload.language && item.version === payload.version));
  }
  assert.equal(h.sent.find(item => item.payload.language === 'java').payload.files[0].name, 'Main.java');
  assert.ok(h.sent.some(item => item.payload.files[0].content.includes('time.process_time() + 0.2')));
});

test('HTTP, malformed, wrong-output, compile and signal failures all count as errors', () => {
  const h = harness();
  for (const response of [
    { status: 503, json: () => ({}) },
    { status: 200, json: () => { throw new Error('malformed'); } },
    { status: 200, json: () => ({ run: { code: 0, stdout: 'wrong' } }) },
    { status: 200, json: () => ({ compile: { code: 1 }, run: { code: 0, stdout: '42' } }) },
    { status: 200, json: () => ({ run: { code: 0, stdout: '42', signal: 'SIGKILL' } }) },
  ]) { h.respond({ ...response, timings: { duration: 100 } }); h.iteration(); }
  assert.ok(h.metrics.get('job_errors').every(sample => sample.value === true));
  assert.equal(h.metrics.get('job_residual').length, 0);
});

test('residual subtracts both stage wall times in milliseconds, not claimed queue wait', () => {
  const h = harness();
  h.respond({ status: 200, timings: { duration: 200 }, json: () => ({
    compile: { code: 0, wall_time: 50 }, run: { code: 0, stdout: '42', wall_time: 20 },
  }) });
  h.iteration();
  assert.equal(h.metrics.get('job_residual')[0].value, 130);
  h.respond({ status: 200, timings: { duration: 200 }, json: () => ({ run: { code: 0, stdout: '42', wall_time: null } }) });
  h.iteration();
  assert.equal(h.metrics.get('job_residual').length, 1);
  const summary = h.handleSummary({ metrics: {
    job_latency: { values: { med: 200, 'p(95)': 300 } },
    job_requests: { values: { count: 10, rate: 2 } }, job_errors: { values: { rate: 0.1 } },
  } }).stdout;
  assert.match(summary, /queue wait: unavailable/);
  assert.match(summary, /200\.0\s+300\.0\s+10\.0%/);
  assert.match(summary, /p50=n\/ams/);
});

test('preflight refuses unavailable locked runtimes and bad execution output', () => {
  const h = harness();
  h.context.http.get = () => ({ status: 200, json: () => [] });
  assert.throws(() => h.setup(), /Locked runtime is missing/);
  h.context.http.get = () => ({ status: 200, json: () => Object.values(JSON.parse(lock).runtimes) });
  h.respond({ status: 200, json: () => ({ run: { code: 1 } }) });
  assert.throws(() => h.setup(), /Piston preflight failed/);
});

test('real pinned k6 completes the full ramp against an isolated mock, with every summary group', {
  skip: process.env.PISTON_CAPACITY_DOCKER_TEST !== '1', timeout: 260000,
}, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nodeImage = readFileSync(path.join(root, 'Dockerfile'), 'utf8').match(/^ARG NODE_IMAGE=(.+)$/m)[1].trim();
  const image = readFileSync(path.join(root, 'scripts/piston-capacity.sh'), 'utf8').match(/image='([^']+)'/)[1];
  const network = `codestead-capacity-test-${process.pid}`;
  const server = `${network}-mock`;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 250000, maxBuffer: 2 * 1024 * 1024 });
  const mock = `const http = require('node:http');
    const runtimes = ${JSON.stringify(Object.values(JSON.parse(lock).runtimes))};
    http.createServer((req,res) => {
      res.setHeader('content-type','application/json');
      if (req.method === 'GET' && req.url === '/api/v2/runtimes') return res.end(JSON.stringify(runtimes));
      let body = ''; req.on('data',chunk => body += chunk); req.on('end',() => {
        const job = JSON.parse(body);
        if (req.url !== '/api/v2/execute' || job.run_timeout !== 3000 || job.compile_timeout !== 10000
          || job.run_memory_limit !== 268435456 || job.compile_memory_limit !== 536870912) {
          res.statusCode=400; return res.end('{}');
        }
        res.end(JSON.stringify({run:{code:0,stdout:'42\\n',wall_time:0},
          ...(['java','c++'].includes(job.language) ? {compile:{code:0,wall_time:0}} : {})}));
      });
    }).listen(2000,'0.0.0.0');`;
  docker('network', 'create', '--internal', network);
  try {
    docker('run', '-d', '--rm', '--name', server, '--network', network, '--network-alias', 'piston',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', nodeImage, 'node', '-e', mock);
    const summary = docker('run', '--rm', '--network', network, '--read-only', '--user', '12345:12345',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
      '--mount', `type=bind,src=${path.join(root, 'load/piston-capacity.js')},dst=/load/piston-capacity.js,readonly`,
      '--mount', `type=bind,src=${path.join(root, 'infra/piston/image-inputs.lock.json')},dst=/load/runtime-lock.json,readonly`,
      '--workdir', '/load', '--env', 'CAPACITY_SLOTS=2', image,
      'run', '--quiet', '--no-usage-report', '--new-machine-readable-summary=false', '/load/piston-capacity.js');
    assert.match(summary, /owner-reported slots=2/);
    for (const group of ['all', 'python_print', 'python_cpu', 'node', 'cpp', 'java',
      'vus_1', 'vus_1_to_10', 'vus_10', 'vus_10_to_20', 'vus_20']) {
      assert.match(summary, new RegExp(`^${group}\\s+[1-9]\\d*\\s+\\d+[.]\\d+\\s+\\d+[.]\\d+\\s+0[.]0%$`, 'm'));
    }
    assert.match(summary, /queue wait: unavailable/);
  } finally {
    try { docker('rm', '-f', server); } finally { docker('network', 'rm', network); }
  }
});
