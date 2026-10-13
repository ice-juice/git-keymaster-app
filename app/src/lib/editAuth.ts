/** 已有记录才要在打开编辑前重新验证；新建没有 id。 */
export function existingRecordNeedsEditAuth(id?: string | null) {
  return typeof id === "string" && id.trim().length > 0;
}
