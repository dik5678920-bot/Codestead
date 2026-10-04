import { Code2, Gauge, ShieldCheck, TimerReset } from "lucide-react";

import { CodeLab } from "@/components/lesson/lesson-workspace";
import { configuredRunnerPresentation } from "@/lib/runner/presentation";
import pageStyles from "@/components/product/product-pages.module.css";

// Read the deployed provider at request time, rather than freezing build copy.
export const dynamic = "force-dynamic";

export default function PlaygroundPage() {
  const runner = configuredRunnerPresentation();
  return <div className={pageStyles.page}><header className={pageStyles.pageHead}><div><span className={pageStyles.eyebrow}>Isolated practice</span><h1>Code lab.</h1><p>Compile and run small experiments on the {runner.description}. This is practice mode, so compiler feedback can be explained by Codestead after the run.</p></div><span className="pill"><ShieldCheck size={14} /> No network · strict limits</span></header><section className={pageStyles.stats}><article className={`${pageStyles.stat} card`}><span><Code2 size={18} /></span><div><strong>5</strong><small>runner languages</small></div></article><article className={`${pageStyles.stat} card`}><span><Gauge size={18} /></span><div><strong>{runner.concurrentJobs}</strong><small>concurrent jobs</small></div></article><article className={`${pageStyles.stat} card`}><span><TimerReset size={18} /></span><div><strong>{runner.runSeconds} sec</strong><small>quick-run wall limit</small>{runner.detail && <small>{runner.detail}</small>}</div></article><article className={`${pageStyles.stat} card`}><span><ShieldCheck size={18} /></span><div><strong>0</strong><small>host code execution</small></div></article></section><CodeLab runnerLabel={runner.runnerLabel} allowLanguageSelection courseId="python" skillId="free-playground" /></div>;
}
