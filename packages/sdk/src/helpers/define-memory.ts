import type {
  MemoryRecord,
  MemoryRecordInput,
  MemorySearchResult,
  MemoryService,
} from "../contracts/memory.js";

export function defineMemory<
  TRecord extends MemoryRecord = MemoryRecord,
  TInput extends MemoryRecordInput = MemoryRecordInput,
  TResult extends MemorySearchResult<TRecord> = MemorySearchResult<TRecord>,
>(memory: MemoryService<TRecord, TInput, TResult>): MemoryService<TRecord, TInput, TResult> {
  return memory;
}
