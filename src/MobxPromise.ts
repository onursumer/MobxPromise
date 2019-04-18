import {action, computed} from "mobx";
import {makePseudoObservable} from "./utils";

/**
 * This tagged union type describes the interoperability of MobxPromise properties.
 */
type MobxPromiseStatus = 'pending' | 'error' | 'complete';
export type MobxPromiseUnionType<R> = (
	{ status: 'pending',  isPending: true,  isError: false, isComplete: false, result: R|undefined, error: Error|undefined } |
	{ status: 'error',    isPending: false, isError: true,  isComplete: false, result: R|undefined, error: Error           } |
	{ status: 'complete', isPending: false, isError: false, isComplete: true,  result: R,           error: Error|undefined }
) & { peekStatus: MobxPromiseStatus };
export type MobxPromiseUnionTypeWithDefault<R> = (
	{ status: 'pending',  isPending: true,  isError: false, isComplete: false, result: R, error: Error|undefined } |
	{ status: 'error',    isPending: false, isError: true,  isComplete: false, result: R, error: Error           } |
	{ status: 'complete', isPending: false, isError: false, isComplete: true,  result: R, error: Error|undefined }
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
	onResult?: (result?:R) => void,

	/**
	 * A function that will be called when the latest promise from invoke() is rejected.
	 * It will not be called for out-of-date promises.
	 */
	onError?: (error:Error) => void,
};
export type MobxPromise_await = () => Array<MobxPromiseUnionTypeWithDefault<any> | MobxPromiseUnionType<any> | MobxPromise<any>>;
export type MobxPromise_invoke<R> = (syncResolve:(result:R)=>void) => PromiseLike<R>;
export type MobxPromiseInputParamsWithDefault<R> = {
	await?: MobxPromise_await,
	invoke: MobxPromise_invoke<R>,
	default: R,
	onResult?: (result:R) => void,
	onError?: (error:Error) => void,
};

/**
 * MobxPromise provides an observable interface for a computed promise.
 * @author adufilie http://github.com/adufilie
 */
export class MobxPromiseImpl<R>
{
	static isPromiseLike(value:any)
	{
		return value != null && typeof value === 'object' && typeof value.then === 'function';
	}

	static normalizeInput<R>(input:MobxPromiseInputParamsWithDefault<R>):MobxPromiseInputParamsWithDefault<R>;
	static normalizeInput<R>(input:MobxPromiseInputUnion<R>, defaultResult?:R):MobxPromiseInputParamsWithDefault<R>;
	static normalizeInput<R>(input:MobxPromiseInputUnion<R>):MobxPromiseInputParams<R>;
	static normalizeInput<R>(input:MobxPromiseInputUnion<R>, defaultResult?:R)
	{
		if (typeof input === 'function')
			return {invoke: input, default: defaultResult};

		if (MobxPromiseImpl.isPromiseLike(input))
			return {invoke: () => input as PromiseLike<R>, default: defaultResult};

		input = input as MobxPromiseInputParams<R>;
		if (defaultResult !== undefined)
			input = {...input, default: defaultResult};
		return input;
	}

	constructor(input:MobxPromiseInputUnion<R>, defaultResult?:R)
	{
		let norm = MobxPromiseImpl.normalizeInput(input, defaultResult);
		this.await = norm.await;
		this.invoke = norm.invoke;
		this.defaultResult = norm.default;
		this.onResult = norm.onResult;
		this.onError = norm.onError;
	}

	private await?:MobxPromise_await;
	private invoke:MobxPromise_invoke<R>;
	private onResult?:(result?:R) => void;
	private onError?:(error:Error) => void;
	private defaultResult?:R;
	private _asyncInvokeCount:number = 0;

	private internalStatus = makePseudoObservable('pending' as 'pending'|'complete'|'error');
	private internalResult = makePseudoObservable(undefined as R|undefined);
	private internalError = makePseudoObservable(undefined as Error|undefined);

	@computed get status():'pending'|'complete'|'error'
	{
		// wait until all MobxPromise dependencies are complete
		if (this.await)
			for (let status of this.await().map(mp => mp.status)) // track all statuses before returning
				if (status !== 'complete')
					return status;


		this.invokeResult; // reference to start computation when status is referenced
		return this.internalStatus.value;
	}

	@computed get peekStatus():'pending'|'complete'|'error'
	{
		// check status without triggering invoke

		// check status of all MobxPromise dependencies
		if (this.await)
			for (let status of this.await().map(mp => mp.peekStatus))
				if (status !== 'complete')
					return status;

		// otherwise, return internal status
		return this.internalStatus.value;
	}

	@computed get isPending() { return this.status == 'pending'; }
	@computed get isComplete() { return this.status == 'complete'; }
	@computed get isError() { return this.status == 'error'; }

	@computed get result():R|undefined
	{
		// checking status may trigger invoke
		if (this.isError || !this.internalResult.isSet)
			return this.defaultResult;

		return this.internalResult.value;
	}

	@computed get error():Error|undefined
	{
		// checking status may trigger invoke
		if (!this.isComplete && this.await)
			for (let error of this.await().map(mp => mp.error)) // track all errors before returning
				if (error)
					return error;

		return this.internalError.value;
	}

	/**
	 * This lets mobx determine when to call this.invoke(),
	 * taking advantage of caching based on observable property access tracking.
	 */
	@computed private get invokeResult()
	{
		let syncResult = {
			isSet: false,
			value: (undefined as R|undefined)
		};

		let promise = this.invoke((result:R)=>{
			syncResult.isSet = true;
			syncResult.value = result;
		});

		// override promise value, and set synchronously, if theres a synchronous resolution
		if (syncResult.isSet) {
			this.setComplete(this._asyncInvokeCount, syncResult.value!);
			return 0;
		} else {
			this._asyncInvokeCount += 1;
			this.setPending(this._asyncInvokeCount, promise);
			return 0;
		}
	}

	@action private setPending(invokeId:number, promise:PromiseLike<R>)
	{
		promise.then(
			result => this.setComplete(invokeId, result),
			error => this.setError(invokeId, error)
		);
		this.internalStatus.value = 'pending';
	}

	@action private setComplete(invokeId:number, result:R)
	{
		if (invokeId === this._asyncInvokeCount)
		{
			this.internalResult.value = result;
			this.internalError.value = undefined;
			this.internalStatus.value = 'complete';

			if (this.onResult)
				this.onResult(this.result); // may use defaultResult
		}
	}

	@action private setError(invokeId:number, error:Error)
	{
		if (invokeId === this._asyncInvokeCount)
		{
			this.internalError.value = error;
			this.internalResult.value = undefined;
			this.internalStatus.value = 'error';

			if (this.onError)
				this.onError(error);
		}
	}
}

export type MobxPromiseFactory = {
	// This provides more information for TypeScript code flow analysis
	<R>(input:MobxPromiseInputParamsWithDefault<R>):MobxPromiseUnionTypeWithDefault<R>;
	<R>(input:MobxPromiseInputUnion<R>, defaultResult: R):MobxPromiseUnionTypeWithDefault<R>;
	<R>(input:MobxPromiseInputUnion<R>):MobxPromiseUnionType<R>;
};

export const MobxPromise = MobxPromiseImpl as {
	// This provides more information for TypeScript code flow analysis
	new <R>(input:MobxPromiseInputParamsWithDefault<R>): MobxPromiseUnionTypeWithDefault<R>;
	new <R>(input:MobxPromiseInputUnion<R>, defaultResult: R): MobxPromiseUnionTypeWithDefault<R>;
	new <R>(input:MobxPromiseInputUnion<R>): MobxPromiseUnionType<R>;
};

export interface MobxPromise<T> extends Pick<MobxPromiseImpl<T>, 'status' | 'error' | 'result' | 'isPending' | 'isError' | 'isComplete' | 'peekStatus'>
{
}

export default MobxPromise;
