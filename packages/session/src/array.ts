/** Index into an array whose bounds the caller has already checked. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Index ${index} is out of range (length ${items.length}).`);
  }
  return item;
}
