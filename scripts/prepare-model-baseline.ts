import {exportBaseline,renderDerived} from './model-evaluation/baseline.ts';
const [command,root,workId,versionId,destination,...extra]=process.argv.slice(2);
if(extra.length||!root||!workId||!versionId||command==='export'&&!destination||!['export','render-derived'].includes(command??''))throw new Error('用法：prepare-model-baseline.ts export <原测试目录> <作品> <版本> <新目录> | render-derived <派生测试目录> <作品> <版本>');
const result=command==='export'?await exportBaseline(root,workId,versionId,destination!):await renderDerived(root,workId,versionId);
console.log(JSON.stringify(result));
