import type { AnyEventObject } from 'xstate';
import type { Operation } from './operation.js';

export interface Delivery {
  readonly event: AnyEventObject;
  readonly operation: Operation | undefined;
  previous: Delivery | undefined;
  next: Delivery | undefined;
}

/** Intrusive queue: detached deliveries retain neither past nor future nodes. */
export class DeliveryQueue implements Iterable<Delivery> {
  private first: Delivery | undefined;
  private last: Delivery | undefined;
  private count = 0;

  get length(): number {
    return this.count;
  }

  append(delivery: Delivery): void {
    delivery.previous = this.last;
    delivery.next = undefined;
    if (this.last) {
      this.last.next = delivery;
    } else {
      this.first = delivery;
    }
    this.last = delivery;
    this.count += 1;
  }

  prepend(delivery: Delivery): void {
    delivery.previous = undefined;
    delivery.next = this.first;
    if (this.first) {
      this.first.previous = delivery;
    } else {
      this.last = delivery;
    }
    this.first = delivery;
    this.count += 1;
  }

  takeFirst(): Delivery | undefined {
    const delivery = this.first;
    if (delivery) {
      this.remove(delivery);
    }
    return delivery;
  }

  removeFirst(event: AnyEventObject): Delivery | undefined {
    for (const delivery of this) {
      if (delivery.event === event) {
        this.remove(delivery);
        return delivery;
      }
    }
    return undefined;
  }

  removeOperation(operation: Operation): number {
    let removed = 0;
    for (const delivery of this) {
      if (delivery.operation === operation) {
        this.remove(delivery);
        removed += 1;
      }
    }
    return removed;
  }

  private remove(delivery: Delivery): void {
    if (delivery.previous) {
      delivery.previous.next = delivery.next;
    } else {
      this.first = delivery.next;
    }
    if (delivery.next) {
      delivery.next.previous = delivery.previous;
    } else {
      this.last = delivery.previous;
    }
    delivery.previous = undefined;
    delivery.next = undefined;
    this.count -= 1;
  }

  *[Symbol.iterator](): IterableIterator<Delivery> {
    let delivery = this.first;
    while (delivery) {
      const next = delivery.next;
      yield delivery;
      delivery = next;
    }
  }
}
