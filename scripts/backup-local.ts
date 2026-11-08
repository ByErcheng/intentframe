import { backupLocal } from "../src/records/local-backup.ts";

// 稳定命令入口；报告和实际资产都留在本机数据目录。
console.log(JSON.stringify(backupLocal(), null, 2));
