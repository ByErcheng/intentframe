import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configuration } from "../config.ts";
import { ownedPath } from "../records/files.ts";
import { purposeSchema, recordIdSchema } from "../records/contracts.ts";
import type { WorkPurpose } from "../records/contracts.ts";
import { OperationStore } from "../records/operation-store.ts";
import { WorkStore } from "../records/work-store.ts";
import { WorkService } from "./work-service.ts";

const purposes: WorkPurpose[] = ["production", "test"];

/** 一个入口按任务事实选择存储区域，不维护可被其他请求改变的全局用途。 */
export class WorkRouter {
  readonly assetRoot: string;
  readonly workRoots: Record<WorkPurpose, string>;
  readonly operations: OperationStore;
  private services = new Map<WorkPurpose, WorkService>();
  private factory: (store: WorkStore) => WorkService;

  constructor(assetRoot = configuration.assetRoot, factory = (store: WorkStore) => new WorkService(store)) {
    this.assetRoot = resolve(assetRoot);
    this.workRoots = { production: this.assetRoot, test: ownedPath(this.assetRoot, "testing") };
    this.operations = new OperationStore(this.assetRoot);
    this.factory = factory;
  }

  service(purpose: WorkPurpose): WorkService {
    purposeSchema.parse(purpose);
    let service = this.services.get(purpose);
    if (!service) {
      service = this.factory(new WorkStore(this.workRoots[purpose], purpose, this.assetRoot));
      if (service.store.dataRoot !== this.workRoots[purpose] || service.store.purpose !== purpose || service.store.assetRoot !== this.assetRoot) {
        throw new Error("任务服务与指定数据区域不一致。");
      }
      this.services.set(purpose, service);
    }
    return service;
  }

  forWork(id: string): WorkService {
    recordIdSchema.parse(id);
    const matches = purposes.filter(purpose => existsSync(this.service(purpose).store.workDirectory(id)));
    if (matches.length !== 1) throw new Error(matches.length ? "作品编号在多个区域重复，须核对原记录，不能自动选择。" : "找不到指定作品；未切换到其他任务或目录。");
    const service = this.service(matches[0]!);
    service.store.read(id); // 验证记录身份、用途和区域；旧记录不补造历史用途。
    return service;
  }

  operation(id: string, purpose?: WorkPurpose) {
    const candidates = purposes.flatMap(area => {
      const store = area === "production" ? this.operations : new OperationStore(this.workRoots.test);
      if (!store.exists(id)) return [];
      const record = store.read(id);
      // 旧回执的目录只帮助定位，保持原文件，不给旧任务补认用途。
      return [{ store, record, purpose: record.purpose ?? area }];
    });
    const matches = purpose ? candidates.filter(item => item.purpose === purpose) : candidates;
    if (matches.length > 1) throw new Error("操作编号在历史区域重复；查询时指定用途核对，不能改号重发。");
    return matches[0];
  }

  scopes() {
    return Object.fromEntries(purposes.map(purpose => [purpose, this.service(purpose).store.scope()?.id]));
  }
}
