import type { SubjectRoleStore } from "../../types.js";

/** Process-local assignments for tests and explicit local setups. */
export class MemorySubjectRoleStore implements SubjectRoleStore {
  private readonly roleKeysBySubject = new Map<string, Set<string>>();

  public async listRoleKeys(subjectId: string): Promise<ReadonlySet<string>> {
    // Return a snapshot so consumers cannot mutate persisted assignments.
    return new Set(this.roleKeysBySubject.get(subjectId));
  }

  public async grantRole(
    subjectId: string,
    roleKey: string,
    _grantedBySubjectId?: string,
  ): Promise<boolean> {
    const keys = this.roleKeysBySubject.get(subjectId) ?? new Set<string>();
    const before = keys.size;
    keys.add(roleKey);
    this.roleKeysBySubject.set(subjectId, keys);
    return keys.size > before;
  }

  public async revokeRole(subjectId: string, roleKey: string): Promise<boolean> {
    const keys = this.roleKeysBySubject.get(subjectId);
    const removed = keys?.delete(roleKey) ?? false;
    if (keys?.size === 0) this.roleKeysBySubject.delete(subjectId);
    return removed;
  }
}
