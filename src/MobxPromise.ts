import {observable, action, computed, whyRun} from "mobx";

/**
 * This tagged union type describes the interoperability of MobxPromise properties.
 */
type MobxPromiseStatus = 'pending' | 'error' | 'complete';
export type MobxPromiseUnionType<R> = (
    { status: 'pending', isPending: true, isError: false, isComplete: false, result: R | undefined, error: Error | undefined } |
    { status: 'error', isPending: false, isError: true, isComplete: false, result: R | undefined, error: Error } |
    { status: 'complete', isPending: false, isError: false, isComplete: true, result: R, error: Error | undefined }
    ) & { peekStatus: MobxPromiseStatus };
export type MobxPromiseUnionTypeWithDefault<R> = (
    { status: 'pending', isPending: true, isError: false, isComplete: false, result: R, error: Error | undefined } |
    { status: 'error', isPending: false, isError: true, isComplete: false, result: R, error: Error } |
    { status: 'complete', isPending: false, isError: false, isComplete: true, result: R, error: Error | undefined }
    ) & { peekStatus: MobxPromiseStatus };

export type MobxPromiseInputUnion<R> = PromiseLike<R> | (() => PromiseLike<R>) | MobxPromiseInputParams<R>;
export type MobxPromiseInputParams<R> = {
    /**
     * A function that returns a list of MobxPromise objects which are dependencies of the invoke function.
     */
    await?: MobxPromise_await,

    /**
     * A function that returns the async result or a promise for the async result.
     */
    invoke: MobxPromise_invoke<R>,

    /**
     * Default result in place of undefined
     */
    default?: R,

    /**
     * A function that will be called when the latest promise from invoke() is resolved.
     * It will not be called for out-of-date promises.
     */
    onResult?: (result?: R) => void,

    /**
     * A function that will be called when the latest promise from invoke() is rejected.
     * It will not be called for out-of-date promises.
     */
    onError?: (error: Error) => void,
};
export type MobxPromise_await = () => Array<MobxPromiseUnionTypeWithDefault<any> | MobxPromiseUnionType<any> | MobxPromise<any>>;
export type MobxPromise_invoke<R> = (syncResolve: (result: R) => PromiseLike<R>) => PromiseLike<R>;
export type MobxPromiseInputParamsWithDefault<R> = {
    await?: MobxPromise_await,
    invoke: MobxPromise_invoke<R>,
    default: R,
    onResult?: (result: R) => void,
    onError?: (error: Error) => void,
};

/**
 * MobxPromise provides an observable interface for a computed promise.
 * @author adufilie http://github.com/adufilie
 */
export class MobxPromiseImpl<R> {
    static isPromiseLike(value: any) {
        return value != null && typeof value === 'object' && typeof value.then === 'function';
    }

    static normalizeInput<R>(input: MobxPromiseInputParamsWithDefault<R>): MobxPromiseInputParamsWithDefault<R>;
    static normalizeInput<R>(input: MobxPromiseInputUnion<R>, defaultResult?: R): MobxPromiseInputParamsWithDefault<R>;
    static normalizeInput<R>(input: MobxPromiseInputUnion<R>): MobxPromiseInputParams<R>;
    static normalizeInput<R>(input: MobxPromiseInputUnion<R>, defaultResult?: R) {
        if (typeof input === 'function')
            return {invoke: input, default: defaultResult};

        if (MobxPromiseImpl.isPromiseLike(input))
            return {invoke: () => input as PromiseLike<R>, default: defaultResult};

        input = input as MobxPromiseInputParams<R>;
        if (defaultResult !== undefined)
            input = {...input, default: defaultResult};
        return input;
    }

    constructor(input: MobxPromiseInputUnion<R>, defaultResult?: R) {
        let norm = MobxPromiseImpl.normalizeInput(input, defaultResult);
        this.await = norm.await;
        this.invoke = norm.invoke;
        this.defaultResult = norm.default;
        this.onResult = norm.onResult;
        this.onError = norm.onError;
    }

    private await?: MobxPromise_await;
    private invoke: MobxPromise_invoke<R>;
    private onResult?: (result?: R) => void;
    private onError?: (error: Error) => void;
    private defaultResult?: R;
    private invokeId: number = 0;
    private _latestInvokeId: number = 0;

    @observable private internalStatus: 'pending' | 'complete' | 'error' = 'pending';
    private internalResult?: R = undefined; // doesnt need to be observable because, since its synchronous,
    //   users of `result` will synchronously register to `status` and `invoke`
    //   and thus to anything that could change the output of `result` - `invoke` handles synchronous
    //   changes, and the only remaining issue is when a promise resolves, which is handled
    //   by the observable `internalStatus` changing.
    private synchronousResult = false;

    @observable.ref private internalError?: Error = undefined;

    private _statusThatAlwaysTriggers = computed(() => {
        // wait until all MobxPromise dependencies are complete
        if (this.await)
            for (let status of this.await().map(mp => mp.status)) // track all statuses before returning
                if (status !== 'complete')
                    return status;

        let status = this.internalStatus; // force mobx to track changes to internalStatus

        if (this.latestInvokeId != this.invokeId)
            status = 'pending';

        if (this.synchronousResult)
            status = 'complete';

        return status;
    }, {equals: (a, b) => false}); // in order to have internalResult not be observable, but still
    //  keep everything properly triggering recomputation, we need
    //  a way for our internal code to always react to any recomputation of
    //  `status`, regardless of whether the result is the same. This accomplishes that.

    @computed get status(): 'pending' | 'complete' | 'error' {
        // we make this @computed so that outside users of `status` still get the expected @computed behavior
        //	of only triggering recomputation when the value changes
        return this._statusThatAlwaysTriggers.get();
    }

    @computed get peekStatus(): 'pending' | 'complete' | 'error' {
        // check status without triggering invoke

        // check status of all MobxPromise dependencies
        if (this.await)
            for (let status of this.await().map(mp => mp.peekStatus))
                if (status !== 'complete')
                    return status;

        // otherwise, return internal status
        let status = this.internalStatus; // force mobx to track changes to internalStatus
        if (this.synchronousResult)
            status = 'complete';
        return status;
    }

    @computed get isPending() {
        return this.status == 'pending';
    }

    @computed get isComplete() {
        return this.status == 'complete';
    }

    @computed get isError() {
        return this.status == 'error';
    }

    @computed get result(): R | undefined {
        // checking `_statusThatAlwaysTriggers` may trigger `invoke`, thus registering `result` to its observables
        if (this._statusThatAlwaysTriggers.get() === "error" || this.internalResult == null)
            return this.defaultResult;

        return this.internalResult;
    }

    @computed get error(): Error | undefined {
        // checking `_statusThatAlwaysTriggers` may trigger `invoke`, thus registering `error` to its observables
        if (this._statusThatAlwaysTriggers.get() !== "complete" && this.await)
            for (let error of this.await().map(mp => mp.error)) // track all errors before returning
                if (error)
                    return error;

        if (this.synchronousResult)
            return undefined; // cant have an error if synchronously complete

        return this.internalError;
    }

    /**
     * This lets mobx determine when to call this.invoke(),
     * taking advantage of caching based on observable property access tracking.
     */
    @computed
    private get latestInvokeId() {
        window.clearTimeout(this._latestInvokeId);
        this.synchronousResult = false;

        let promise = this.invoke((result: R) => {
            this.synchronousResult = true;
            this.internalResult = result;
            return Promise.resolve(result);
        });

        if (this.synchronousResult) {
            // synchronous result means we don't have to update anything
            this.invokeId += 1; // have to change the value in order to trigger recomputation of users of `latestInvokeId`

            if (this.onResult) {
                const internalResult = this.internalResult;
                setTimeout(() => {
                    this.onResult!(internalResult);
                });
            }
            return this.invokeId;
        } else {
            // no synchronous result means we need to update everything and react to promise
            let invokeId: number = window.setTimeout(() => this.setPending(invokeId, promise));
            return this._latestInvokeId = invokeId;
        }
    }

    @action
    private setPending(invokeId: number, promise: PromiseLike<R>) {
        this.invokeId = invokeId;
        promise.then(
            result => this.setComplete(invokeId, result),
            error => this.setError(invokeId, error)
        );
        this.internalStatus = 'pending';
    }

    @action
    private setComplete(invokeId: number, result: R) {
        if (invokeId === this.invokeId) {
            this.internalResult = result;
            this.internalError = undefined;
            this.internalStatus = 'complete';

            if (this.onResult)
                this.onResult(this.result); // may use defaultResult
        }
    }

    @action
    private setError(invokeId: number, error: Error) {
        if (invokeId === this.invokeId) {
            this.internalError = error;
            this.internalResult = undefined;
            this.internalStatus = 'error';

            if (this.onError)
                this.onError(error);
        }
    }
}

export type MobxPromiseFactory = {
    // This provides more information for TypeScript code flow analysis
    <R>(input: MobxPromiseInputParamsWithDefault<R>): MobxPromiseUnionTypeWithDefault<R>;
    <R>(input: MobxPromiseInputUnion<R>, defaultResult: R): MobxPromiseUnionTypeWithDefault<R>;
    <R>(input: MobxPromiseInputUnion<R>): MobxPromiseUnionType<R>;
};

export const MobxPromise = MobxPromiseImpl as {
    // This provides more information for TypeScript code flow analysis
    new<R>(input: MobxPromiseInputParamsWithDefault<R>): MobxPromiseUnionTypeWithDefault<R>;
    new<R>(input: MobxPromiseInputUnion<R>, defaultResult: R): MobxPromiseUnionTypeWithDefault<R>;
    new<R>(input: MobxPromiseInputUnion<R>): MobxPromiseUnionType<R>;
};

export interface MobxPromise<T> extends Pick<MobxPromiseImpl<T>, 'status' | 'error' | 'result' | 'isPending' | 'isError' | 'isComplete' | 'peekStatus'> {
}

export default MobxPromise;
