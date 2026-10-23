export type ExpiryHeapRecord<TValue> = {
  readonly expiresAt: number
  readonly value: TValue
}

export function pushExpiryRecord<TValue>(heap: ExpiryHeapRecord<TValue>[], record: ExpiryHeapRecord<TValue>): void {
  heap.push(record)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    const child = heap[index]!
    const parentRecord = heap[parent]!
    if (parentRecord.expiresAt <= child.expiresAt) return

    heap[parent] = child
    heap[index] = parentRecord
    index = parent
  }
}

export function peekExpiryRecord<TValue>(heap: readonly ExpiryHeapRecord<TValue>[]): ExpiryHeapRecord<TValue> | undefined {
  return heap[0]
}

export function popExpiryRecord<TValue>(heap: ExpiryHeapRecord<TValue>[]): ExpiryHeapRecord<TValue> | undefined {
  const top = heap[0]
  if (!top) return undefined

  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    siftDown(heap, 0)
  }
  return top
}

export function heapifyExpiryRecords<TValue>(heap: ExpiryHeapRecord<TValue>[]): void {
  for (let index = (heap.length >> 1) - 1; index >= 0; index -= 1) {
    siftDown(heap, index)
  }
}

function siftDown<TValue>(heap: ExpiryHeapRecord<TValue>[], start: number): void {
  let index = start
  while (true) {
    const left = (index * 2) + 1
    const right = left + 1
    let smallest = index
    if (left < heap.length && heap[left]!.expiresAt < heap[smallest]!.expiresAt) smallest = left
    if (right < heap.length && heap[right]!.expiresAt < heap[smallest]!.expiresAt) smallest = right
    if (smallest === index) return

    const current = heap[index]!
    heap[index] = heap[smallest]!
    heap[smallest] = current
    index = smallest
  }
}
