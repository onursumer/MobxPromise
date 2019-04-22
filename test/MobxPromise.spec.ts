import {assert} from "chai";
import * as Sinon from 'sinon';
import * as mobx from "mobx";
import MobxPromise from "../src/mobxpromise";

function spy<T extends (...args: any[]) => void>(func: T) {
    return Sinon.spy(func) as T & Sinon.SinonSpy;
}

async function observeOnce<T>(expression: () => T) {
    let n = 0;
    let value: T;
    return new Promise(resolve => {
        mobx.when(
            () => {
                value = expression();
                return n++ > 0;
            },
            () => resolve(value)
        );
    });
}

function sleep() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function whenComplete(promise: any) {
    return new Promise(resolve => {
        mobx.when(
            () => promise.isComplete,
            resolve
        );
    });
}

describe('MobxPromise', () => {
    const INITIAL = 'initial';
    const SYNC_INITIAL = 'syncinitial';
    const DEFAULT = 'default';
    let reactionDisposer: mobx.IReactionDisposer | undefined;

    afterEach(() => {
        if (reactionDisposer) {
            reactionDisposer();
            reactionDisposer = undefined;
        }
    });

    it('short use flow, starting with sync result', async () => {

        let value = mobx.observable(INITIAL);
        let syncValue = mobx.observable(SYNC_INITIAL);
        let shouldSyncResolve = mobx.observable(true);
        let params = {
            invoke: spy((syncResolve) => {
                if (shouldSyncResolve.get()) {
                    return syncResolve(syncValue.get());
                } else {
                    return Promise.resolve(value.get());
                }
            }),
            default: DEFAULT,
            onResult: spy((result: string) => null)
        };
        let mp = new MobxPromise(params);
        assert.equal(mp.peekStatus, "pending", "pending status initially");
        // we have to set up a reaction or @computed properties won't be cached.
        reactionDisposer = mobx.autorun(() => mp.result);
        assert.equal(mp.status, 'complete', 'status is complete because result is synchronous');

        assert.equal(params.invoke.callCount, 1, "called once by reaction");
        assert.equal(mp.result, syncValue.get(), "synchronous result is sync value");
        assert.equal(mp.status, 'complete', 'status is complete when sync result updates');
        assert.equal(mp.peekStatus, "complete", "peekStatus is same as status");
        shouldSyncResolve.set(false);
        assert.equal(mp.result, syncValue.get(), "result is still the synchronous while async result is pending");
        await whenComplete(mp);
        assert.equal(params.invoke.callCount, 2, "called a second time to change branch");
        assert.equal(mp.result, value.get(), "async value now");
        assert.equal(mp.status, 'complete', 'status is complete when async result updates');
        assert.equal(mp.peekStatus, "complete", "peekStatus is same as status");

        return true;
    });

    it('use flow, starting with async result', async () => {
        let value = mobx.observable(INITIAL);
        let syncValue = mobx.observable(SYNC_INITIAL);
        let shouldSyncResolve = mobx.observable(false);
        let params = {
            invoke: spy((syncResolve) => {
                if (shouldSyncResolve.get()) {
                    return syncResolve(syncValue.get());
                } else {
                    return Promise.resolve(value.get());
                }
            }),
            default: DEFAULT,
            onResult: spy((result: string) => null)
        };
        let mp = new MobxPromise(params);
        assert.equal(mp.peekStatus, "pending", "pending status initially");
        assert.isTrue(params.invoke.notCalled, 'invoke is not called until we attempt to access properties');
        await sleep();
        assert.isTrue(params.invoke.notCalled, "checking peekStatus does not trigger invoke");

        assert.equal(mp.peekStatus, "pending", "peekStatus is same as status");
        assert.equal(mp.status, 'pending', 'status is pending immediately after creation');
        assert.isTrue(params.invoke.calledOnce, 'invoke called once when status is checked');
        assert.equal(mp.result, DEFAULT, 'result is set to default value');
        assert.isTrue(params.invoke.calledTwice, 'invoke not cached since its not in a reaction, called again when result is checked');

        // we have to set up a reaction or @computed properties won't be cached.
        reactionDisposer = mobx.autorun(() => mp.result);
        await whenComplete(mp);
        assert.equal(params.onResult.callCount, 1, "even though invoke was called twice, those were both in the same stack frame, so only one ends up counting");
        assert.deepEqual(params.onResult.lastCall.args, [INITIAL]);
        assert.equal(mp.result, INITIAL, 'observed initial result');
        assert.equal(mp.status, 'complete', 'status is complete when result updates');
        assert.equal(mp.peekStatus, "complete", "peekStatus is same as status");

        value.set('this result should be skipped');
        assert.equal(mp.peekStatus, "complete", "peekStatus does not synchronously respond to changed dependency");
        assert.equal(mp.status, 'pending', 'status synchronously responds to changed dependency');
        assert.equal(mp.result, INITIAL, 'result does not synchronously respond to changed dependency');
        value.set('updated result');
        await whenComplete(mp);
        assert.equal(params.onResult.callCount, 2, "even though value was set twice->invoke was called twice, those were both in the same stack frame, so only one ends up counting");
        assert.deepEqual(params.onResult.lastCall.args, ["updated result"]);
        assert.equal(mp.peekStatus, "complete", "peekStatus is same as status");
        assert.equal(mp.status, 'complete', 'status updated to complete');
        assert.equal(mp.result, value.get(), 'result updated to latest value');

        assert.equal(params.invoke.callCount, 5, "at this point we're at 5 calls");

        shouldSyncResolve.set(true);
        assert.equal(params.invoke.callCount, 6, "invoke should be triggered again by an observable changing");
        assert.equal(mp.result, SYNC_INITIAL, "we should get the result from the sync resolution, not from the return value");
        assert.equal(params.onResult.callCount, 2, "onResult is called asynchronously so it wasnt called again yet");
        value.set("this branch is not followed so it should not trigger");
        assert.equal(params.invoke.callCount, 6, "branch with that observable not followed last time, so should not retrigger invoke");
        await sleep(); // give time for onResult to fire
        assert.equal(params.onResult.callCount, 3, "onResult was called from the syncResolve");
        assert.deepEqual(params.onResult.lastCall.args, [SYNC_INITIAL]);
        syncValue.set("new sync value");
        assert.equal(params.invoke.callCount, 7, "branch with sync resolve was followed last so it should retrigger invoke");
        assert.equal(mp.result, syncValue.get(), "we should have received sync value");
        await sleep(); // give time for onResult to fire
        assert.equal(params.onResult.callCount, 4, "onResult was called for the synchronous result");
        assert.deepEqual(params.onResult.lastCall.args, [syncValue.get()]);

        shouldSyncResolve.set(false);
        assert.equal(params.invoke.callCount, 8, "invoke should be triggered again by an observable changing");
        assert.equal(mp.result, syncValue.get(), "gives last sync result while pending");
        assert.equal(params.onResult.callCount, 4, "onResult isnt called yet because the async result setTimeout wont happen until next frame");
        await whenComplete(mp);
        assert.equal(params.invoke.callCount, 8, "invoke hasnt been called again");
        assert.equal(mp.result, value.get(), "back to async branch result");
        assert.equal(params.onResult.callCount, 5, "onResult should be called with the asynchronous result");
        assert.deepEqual(params.onResult.lastCall.args, [value.get()]);
        syncValue.set("sync should not trigger now");
        assert.equal(params.invoke.callCount, 8, "invoke hasnt been called again by sync change, were in async branch of `if`");
        const prevValue = value.get();
        value.set("async should trigger again");
        assert.equal(params.invoke.callCount, 9, "async triggered again");
        assert.equal(mp.result, prevValue, "pending should give previous result");

        return true;
    });

    it('will not keep calling invoke when not observed', async () => {
        let value = mobx.observable(INITIAL);
        let params = {
            invoke: spy(async () => value.get()),
            default: DEFAULT,
            reaction: spy((result: string) => null)
        };
        let mp = new MobxPromise(params);

        assert.equal(mp.peekStatus, "pending", "pending status initially");
        await sleep();
        assert.isTrue(params.invoke.notCalled, "checking peekStatus does not trigger invoke");
        assert.equal(mp.result, DEFAULT, 'result matches default value when first requested');

        reactionDisposer = mobx.autorun(() => mp.result);
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                try {
                    let callCount = params.invoke.callCount;
                    assert.equal(mp.result, value.get(), 'result using latest value');
                    assert.equal(params.invoke.callCount, callCount, 'not invoked again');
                    assert.equal(mp.peekStatus, "complete", "peekStatus is complete");
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            }, 200);
        });
    });
});
