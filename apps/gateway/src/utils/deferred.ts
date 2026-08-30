export type DeferredRejectReason =
  | Error
  | Record<string, string | number | boolean | null | undefined>
  | string
  | number
  | boolean
  | null
  | undefined;

export interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: DeferredRejectReason) => void;
}

export function withResolvers<T>(): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: DeferredRejectReason) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
