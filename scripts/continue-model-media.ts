import{continueMedia}from'./model-evaluation/continue-media.ts';import{readJson}from'./model-evaluation/plan.ts';
const[round,runId,budgets,attemptId,...extra]=process.argv.slice(2);if(!round||!runId||!budgets||extra.length)throw new Error('用法：continue-model-media.ts <轮次目录> <运行编号> <媒体预算.json> [新接续编号]；旧接续须明确失败，未知不重发');
const r=await continueMedia(round,runId,readJson(budgets),attemptId);console.log(JSON.stringify({runId:r.runId,status:r.status,error:r.error,elapsedMs:r.elapsedMs,versions:r.versions}));
