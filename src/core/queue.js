// Phase 10.1 — FIFO Queue Data Structure

/**
 * Create a new, independent FIFO queue instance.
 *
 * Each call returns a fresh object backed by its own internal array;
 * two queues never share state.
 *
 * @returns {Object} An object with the operations listed below.
 */
export function createQueue() {
  const items = [];

  /**
   * Add an item to the back of the queue.
   *
   * @param {*} item — Any value (including `null`, `0`, `''`).
   * @returns {void}
   */
  function enqueue(item) {
    items.push(item);
  }

  /**
   * Remove and return the front item, or `undefined` if empty.
   *
   * Returns `undefined` (not a sentinel or error object) when the queue is
   * empty because `undefined` is the canonical "no value" in JavaScript — it
   * is implicitly returned by functions with no explicit return, and callers
   * can distinguish it from any real queued value.  A string like `"__EMPTY__"`
   * would collide with legitimate data; throwing would force every caller to
   * wrap the call in try/catch.  `undefined` keeps the API silent and minimal.
   *
   * @returns {*|undefined} The dequeued item, or `undefined` if the queue was empty.
   */
  function dequeue() {
    return items.shift();
  }

  /**
   * Return the front item without removing it.
   *
   * Does NOT mutate the queue — `size()` is unchanged after this call.
   * Returns `undefined` when the queue is empty (same rationale as `dequeue`).
   *
   * @returns {*|undefined} The front item, or `undefined` if the queue was empty.
   */
  function peek() {
    return items[0];
  }

  /**
   * Return the number of items currently in the queue.
   *
   * @returns {number}
   */
  function size() {
    return items.length;
  }

  /**
   * Return `true` if the queue contains no items.
   *
   * @returns {boolean}
   */
  function isEmpty() {
    return items.length === 0;
  }

  /**
   * Remove all items from the queue.
   *
   * Returns nothing (`undefined`). After this call `size()` is `0` and
   * `isEmpty()` is `true`.
   *
   * @returns {void}
   */
  function clear() {
    items.length = 0;
  }

  return { enqueue, dequeue, peek, size, isEmpty, clear };
}
