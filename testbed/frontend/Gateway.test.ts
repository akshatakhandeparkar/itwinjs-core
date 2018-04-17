/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import { GatewayRequest, Gateway, GatewayOperation, GatewayRequestEvent } from "@bentley/imodeljs-common";
import { TestGateway, TestOp1Params, TestGateway2 } from "../common/TestGateway";
import { assert } from "chai";
import { Id64 } from "@bentley/bentleyjs-core";
import { TestbedConfig } from "../common/TestbedConfig";
import { CONSTANTS } from "../common/Testbed";

const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Gateway", () => {
  it("should marshall types over the wire", async () => {
    const params = new TestOp1Params(1, 1);
    const remoteSum = await TestGateway.getProxy().op1(params);
    assert.strictEqual(remoteSum, params.sum());
  });

  it("should support toJSON/fromJSON", async () => {
    const id1 = new Id64();
    const id2 = await TestGateway.getProxy().op2(id1);
    assert.isTrue(id1.equals(id2));
  });

  it("should support toJSON and fall back to constructor when fromJSON does not exist", async () => {
    const date1 = new Date();
    const date2 = await TestGateway.getProxy().op3(date1);
    assert.strictEqual(date1.getTime(), date2.getTime());
  });

  it("should support Map", async () => {
    const map1 = new Map();
    map1.set(0, "a");
    map1.set("x", 1);
    map1.set(true, { y: "b" });
    map1.set(false, new Date());
    map1.set("params", new TestOp1Params(1, 1));
    map1.set("id", new Id64());

    const map2 = await TestGateway.getProxy().op4(map1);
    assert.equal(map1.size, map2.size);

    map2.forEach((v, k) => {
      if (v instanceof Date)
        assert.strictEqual(v.getTime(), map1.get(k).getTime());
      else if (v instanceof Id64)
        assert.isTrue(v.equals(map1.get(k)));
      else if (v instanceof TestOp1Params)
        assert.strictEqual(v.sum(), map1.get(k).sum());
      else if (typeof (v) === "object")
        assert.strictEqual(JSON.stringify(v), JSON.stringify(map1.get(k)));
      else
        assert.strictEqual(v, map1.get(k));
    });
  });

  it("should support Set", async () => {
    const set1 = new Set();
    set1.add(1);
    set1.add("x");
    set1.add(true);
    set1.add({ y: "b" });
    set1.add(new Date());
    set1.add(new TestOp1Params(1, 1));
    set1.add(new Id64());

    const set2 = await TestGateway.getProxy().op5(set1);
    assert.equal(set1.size, set2.size);

    const set1Items = Array.from(set1);
    const set2Items = Array.from(set2);

    for (let i = 0; i !== set1Items.length; ++i) {
      const v = set2Items[i];

      if (v instanceof Date)
        assert.strictEqual(v.getTime(), set1Items[i].getTime());
      else if (v instanceof Id64)
        assert.isTrue(v.equals(set1Items[i]));
      else if (v instanceof TestOp1Params)
        assert.strictEqual(v.sum(), set1Items[i].sum());
      else if (typeof (v) === "object")
        assert.strictEqual(JSON.stringify(v), JSON.stringify(set1Items[i]));
      else
        assert.strictEqual(v, set1Items[i]);
    }
  });

  it("should permit an unregistered type", async () => {
    class InternalData {
      constructor(public x: number, public y: number) { }
    }

    const data1 = new InternalData(1, 2);
    const data2 = await TestGateway.getProxy().op6(data1);
    assert.strictEqual(data1.x, data2.x);
    assert.strictEqual(data1.y, data2.y);
  });

  it("should report aggregate operation load profile information", async () => {
    const load = GatewayRequest.aggregateLoad;
    const frontendInitialReq = load.lastRequest;
    const frontendInitialResp = load.lastResponse;

    await timeout(1);

    const backendAggregate1 = await TestGateway.getProxy().op7();
    assert.isAbove(load.lastRequest, frontendInitialReq);
    assert.isAbove(load.lastResponse, frontendInitialResp);

    await timeout(1);

    const backendAggregate2 = await TestGateway.getProxy().op7();
    assert.isAbove(backendAggregate2.lastRequest, backendAggregate1.lastRequest);
    assert.isAbove(backendAggregate2.lastResponse, backendAggregate1.lastResponse);
  });

  it("should support pending operations", async () => {
    const op8 = GatewayOperation.lookup(TestGateway, "op8");

    let receivedPending = false;

    const removeListener = GatewayRequest.events.addListener((type: GatewayRequestEvent, request: GatewayRequest) => {
      if (type !== GatewayRequestEvent.PendingUpdateReceived || request.operation !== op8)
        return;

      assert.isFalse(receivedPending);
      receivedPending = true;
      assert.equal(request.extendedStatus, TestGateway.OP8_PENDING_MESSAGE);
    });

    Gateway.getProxyForGateway(TestGateway).configuration.pendingOperationRetryInterval = 1;

    const response1 = await TestGateway.getProxy().op8(1, 1);
    assert.equal(response1.initializer, TestGateway.OP8_INITIALIZER);
    assert.equal(response1.sum, 2);

    const response2 = await TestGateway.getProxy().op8(2, 2);
    assert.equal(response2.initializer, TestGateway.OP8_INITIALIZER);
    assert.equal(response2.sum, 4);

    assert.isTrue(receivedPending);
    removeListener();
  });

  it("should support supplied gateway implementation instances", async () => {
    try {
      await TestGateway2.getProxy().op1(1);
      assert(false);
    } catch (err) {
      assert(true);
    }

    assert(TestbedConfig.sendToMainSync({ name: CONSTANTS.REGISTER_TEST_GATEWAY2IMPL_CLASS_MESSAGE, value: undefined }));

    const response1 = await TestGateway2.getProxy().op1(1);
    assert.equal(response1, 1);

    assert(TestbedConfig.sendToMainSync({ name: CONSTANTS.REPLACE_TEST_GATEWAY2IMPL_INSTANCE_MESSAGE, value: undefined }));

    const response2 = await TestGateway2.getProxy().op1(2);
    assert.equal(response2, 2);
  });
});
