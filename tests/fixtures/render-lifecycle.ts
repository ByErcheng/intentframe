import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderVersion } from "../../src/media/render.ts";
import { StopRequested } from "../../src/runtime/execution-control.ts";

const directory = process.argv[2]!, mode = process.argv[3]!;
const controller = new AbortController();
mkdirSync(join(directory, "source"), { recursive: true });
const entry = join(directory, "source/entry.tsx");
writeFileSync(entry, 'import React from "react";import {Composition,registerRoot,AbsoluteFill} from "remotion";' +
  'const Scene=()=>{' + (mode === "failure" ? 'throw new Error("合成帧渲染失败");' : '') +
  'return <AbsoluteFill style={{backgroundColor:"red"}}/>;};' +
  'registerRoot(()=> <Composition id="Video" component={Scene} durationInFrames={120} fps={30} width={160} height={90}/>);');
const stages: string[] = [];
try {
  await renderVersion(entry, join(directory, "video.mp4"), join(directory, "cache"), {
    signal: controller.signal,
    onStage: stage => {
      stages.push(stage);
      process.stdout.write(JSON.stringify({ stage, at: Date.now() }) + "\n");
      if (mode === "cancel-" + stage) {
        // 启动取消须在 renderMedia 已进入异步初始化后送达，覆盖本次发现的竞态。
        if (stage === "render" || stage === "browser" || stage === "composition") setTimeout(() => controller.abort(new StopRequested("合成取消：" + stage)), 0);
        else controller.abort(new StopRequested("合成取消：" + stage));
      }
    },
  });
  writeFileSync(join(directory, "result.json"), JSON.stringify({ status: "completed", stages }));
} catch (error) {
  writeFileSync(join(directory, "result.json"), JSON.stringify({ status: "rejected", stages,
    error: error instanceof Error ? error.message : String(error), reasonPreserved: error instanceof StopRequested }));
}
process.stdout.write(JSON.stringify({ returned: true, at: Date.now() }) + "\n");
// 不调用 process.exit：测试须确认依赖的实际资源均释放，进程可以自然退出。
