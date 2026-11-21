import type { AnyEventObject } from 'xstate';
import type { Operation } from './operation.js';

export interface MirroredMailboxEntry {
  readonly event: AnyEventObject;
  readonly operation: Operation | undefined;
  previous: MirroredMailboxEntry | undefined;
  next: MirroredMailboxEntry | undefined;
}

/** Intrusive queue: detached entries retain neither past nor future nodes. */
export class MirroredMailboxQueue implements Iterable<MirroredMailboxEntry> {
  private first: MirroredMailboxEntry | undefined;
  private last: MirroredMailboxEntry | undefined;
  private count = 0;

  get length(): number {
    return this.count;
  }

  append(entry: MirroredMailboxEntry): void {
    entry.previous = this.last;
    entry.next = undefined;
    if (this.last) {
      this.last.next = entry;
    } else {
      this.first = entry;
    }
    this.last = entry;
    this.count += 1;
  }

  prepend(entry: MirroredMailboxEntry): void {
    entry.previous = undefined;
    entry.next = this.first;
    if (this.first) {
      this.first.previous = entry;
    } else {
      this.last = entry;
    }
    this.first = entry;
    this.count += 1;
  }

  takeFirst(): MirroredMailboxEntry | undefined {
    const entry = this.first;
    if (entry) {
      this.remove(entry);
    }
    return entry;
  }

  removeFirst(event: AnyEventObject): MirroredMailboxEntry | undefined {
    for (const entry of this) {
      if (entry.event === event) {
        this.remove(entry);
        return entry;
      }
    }
    return undefined;
  }

  removeOperation(operation: Operation): number {
    let removed = 0;
    for (const entry of this) {
      if (entry.operation === operation) {
        this.remove(entry);
        removed += 1;
      }
    }
    return removed;
  }

  private remove(entry: MirroredMailboxEntry): void {
    if (entry.previous) {
      entry.previous.next = entry.next;
    } else {
      this.first = entry.next;
    }
    if (entry.next) {
      entry.next.previous = entry.previous;
    } else {
      this.last = entry.previous;
    }
    entry.previous = undefined;
    entry.next = undefined;
    this.count -= 1;
  }

  *[Symbol.iterator](): IterableIterator<MirroredMailboxEntry> {
    let entry = this.first;
    while (entry) {
      const next = entry.next;
      yield entry;
      entry = next;
    }
  }
}
