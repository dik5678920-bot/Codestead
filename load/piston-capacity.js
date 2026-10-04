import http from 'k6/http';
import execution from 'k6/execution';
import { fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const origin = 'http://piston:2000';
const runtimes = JSON.parse(open('./runtime-lock.json')).runtimes;
const workloads = [
  { name: 'python_print', runtime: 'python', file: 'main.py', source: 'print(42)' },
  { name: 'python_cpu', runtime: 'python', file: 'main.py', source: 'import time\nend = time.process_time() + 0.2\nx = 0\nwhile time.process_time() < end:\n    x += 1\nprint(42)' },
  { name: 'node', runtime: 'javascript', file: 'main.js', source: 'console.log(42)' },
  { name: 'cpp', runtime: 'cpp', file: 'main.cpp', source: '#include <iostream>\nint main() { std::cout << 42 << "\\n"; }' },
  { name: 'java', runtime: 'java', file: 'Main.java', source: 'public class Main { public static void main(String[] args) { System.out.println(42); } }' },
];
const phases = ['1', '1_to_10', '10', '10_to_20', '20'];
const latency = new Trend('job_latency', true);
const residual = new Trend('job_residual', true);
const errors = new Rate('job_errors');
const requests = new Counter('job_requests');
const thresholds = { job_errors: ['rate<0.01'], job_requests: ['count>0'] };
for (const workload of workloads) {
  thresholds[`job_latency{kind:${workload.name}}`] = ['p(95)>=0'];
  thresholds[`job_errors{kind:${workload.name}}`] = ['rate<0.01'];
  thresholds[`job_requests{kind:${workload.name}}`] = ['count>0'];
}
for (const phase of phases) {
  thresholds[`job_latency{phase:${phase}}`] = ['p(95)>=0'];
  thresholds[`job_errors{phase:${phase}}`] = ['rate<0.01'];
  thresholds[`job_requests{phase:${phase}}`] = ['count>0'];
}
export const options = {
  scenarios: { capacity: { executor: 'ramping-vus', startVUs: 1,
    stages: [{ duration: '30s', target: 1 }, { duration: '45s', target: 10 },
      { duration: '30s', target: 10 }, { duration: '45s', target: 20 }, { duration: '30s', target: 20 }],
    gracefulStop: '46s', gracefulRampDown: '46s' } },
  thresholds, summaryTrendStats: ['med', 'p(95)'], setupTimeout: '4m',
  systemTags: ['name', 'method', 'status', 'expected_response'],
};

function submit(workload) {
  const runtime = runtimes[workload.runtime];
  return http.post(`${origin}/api/v2/execute`, JSON.stringify({
    language: runtime.language, version: runtime.version,
    files: [{ name: workload.file, content: workload.source }], stdin: '', args: [],
    run_timeout: 3000, compile_timeout: 10000,
    run_memory_limit: 268435456, compile_memory_limit: 536870912,
  }), { headers: { 'Content-Type': 'application/json' }, timeout: '45s', redirects: 0,
    tags: { name: 'piston_execute' } });
}

function result(response) {
  let body;
  try { body = response.json(); } catch { return { ok: false }; }
  const compiled = body?.compile;
  const ran = body?.run;
  return { body, ok: response.status === 200 && ran?.code === 0 && !ran.signal
    && !ran.status && ran.stdout?.trim() === '42'
    && (!compiled || (compiled.code === 0 && !compiled.signal && !compiled.status)) };
}

export function setup() {
  const inventory = http.get(`${origin}/api/v2/runtimes`, { timeout: '15s', redirects: 0 });
  let available;
  try { available = inventory.json(); } catch { fail('Piston runtime inventory is unavailable.'); }
  for (const workload of workloads) {
    const runtime = runtimes[workload.runtime];
    if (inventory.status !== 200 || !Array.isArray(available)
      || !available.some(item => item.language === runtime.language && item.version === runtime.version)) {
      fail(`Locked runtime is missing: ${workload.name}`);
    }
    if (!result(submit(workload)).ok) fail(`Piston preflight failed: ${workload.name}`);
  }
}

export default function () {
  const elapsed = Date.now() - execution.scenario.startTime;
  const phase = elapsed < 30000 ? '1' : elapsed < 75000 ? '1_to_10'
    : elapsed < 105000 ? '10' : elapsed < 150000 ? '10_to_20' : '20';
  const workload = workloads[(__VU + __ITER - 1) % workloads.length];
  const response = submit(workload);
  const parsed = result(response);
  const tags = { kind: workload.name, phase };
  requests.add(1, tags);
  latency.add(response.timings.duration, tags);
  errors.add(!parsed.ok, tags);
  // wall_time is already milliseconds in this pinned Piston API. Only subtract
  // complete successful stage timings; never present the remainder as queue wait.
  const runWall = parsed.body?.run?.wall_time;
  const compileWall = parsed.body?.compile?.wall_time;
  if (parsed.ok && Number.isFinite(runWall) && runWall >= 0
    && (!parsed.body.compile || (Number.isFinite(compileWall) && compileWall >= 0))) {
    residual.add(Math.max(0, response.timings.duration - runWall - (compileWall ?? 0)));
  }
  sleep(0.2);
}

export function handleSummary(data) {
  const values = name => data.metrics[name]?.values ?? {};
  const number = value => Number.isFinite(value) ? value.toFixed(1) : 'n/a';
  const row = (label, selector = '') => {
    const timing = values(`job_latency${selector}`);
    return `${label.padEnd(12)} ${String(values(`job_requests${selector}`).count ?? 0).padStart(6)} ${number(timing.med).padStart(9)} ${number(timing['p(95)']).padStart(9)} ${number(values(`job_errors${selector}`).rate * 100).padStart(7)}%`;
  };
  const overhead = values('job_residual');
  const output = [
    `Piston capacity | owner-reported slots=${__ENV.CAPACITY_SLOTS || 'unknown'} | 1 -> 10 -> 20 VUs / 180s + drain`,
    'group          jobs    p50 ms    p95 ms   errors', row('all'),
    ...workloads.map(workload => row(workload.name, `{kind:${workload.name}}`)),
    ...phases.map(phase => row(`vus_${phase}`, `{phase:${phase}}`)),
    `Throughput: ${number(values('job_requests').rate)} jobs/s | queue wait: unavailable in Piston API`,
    `Residual overhead (queue + setup/cleanup + transport): p50=${number(overhead.med)}ms p95=${number(overhead['p(95)'])}ms`,
    'Errors include HTTP failures, timeouts, compile/run failures and incorrect output. Threshold: <1%.',
  ];
  return { stdout: `${output.join('\n')}\n` };
}
