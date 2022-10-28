/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { assert, expect } from "chai";
import * as path from "path";
import * as sinon from "sinon";
import { RpcRegistry } from "@itwin/core-common";
import { BriefcaseManager } from "../BriefcaseManager";
import { SnapshotDb } from "../IModelDb";
import { IModelHost, IModelHostConfiguration, IModelHostOptions, KnownLocations } from "../IModelHost";
import { Schemas } from "../Schema";
import { AzureBlobStorage } from "../CloudStorageBackend";
import { KnownTestLocations } from "./KnownTestLocations";
import { AzureServerStorage } from "@itwin/object-storage-azure";
import { ServerStorage } from "@itwin/object-storage-core";
import { TestUtils } from "./TestUtils";
import { IModelTestUtils } from "./IModelTestUtils";

describe("IModelHost", () => {
  const opts = { cacheDir: path.join(__dirname, ".cache") };
  beforeEach(async () => {
    await TestUtils.shutdownBackend();
  });

  afterEach(async () => {
    sinon.restore();
  });

  after(async () => {
    await TestUtils.startBackend();
  });

  it("valid default configuration", async () => {
    await IModelHost.startup(opts);

    // Valid registered implemented RPCs
    expect(RpcRegistry.instance.implementationClasses.size).to.equal(5);
    expect(RpcRegistry.instance.implementationClasses.get("IModelReadRpcInterface")).to.exist;
    expect(RpcRegistry.instance.implementationClasses.get("IModelTileRpcInterface")).to.exist;
    expect(RpcRegistry.instance.implementationClasses.get("SnapshotIModelRpcInterface")).to.exist;
    expect(RpcRegistry.instance.implementationClasses.get("WipRpcInterface")).to.exist;
    expect(RpcRegistry.instance.implementationClasses.get("DevToolsRpcInterface")).to.exist;

    expect(Schemas.getRegisteredSchema("BisCore")).to.exist;
    expect(Schemas.getRegisteredSchema("Generic")).to.exist;
    expect(Schemas.getRegisteredSchema("Functional")).to.exist;
  });

  it("should raise onAfterStartup events", async () => {
    const eventHandler = sinon.spy();
    IModelHost.onAfterStartup.addOnce(eventHandler);
    await IModelHost.startup(opts);
    expect(eventHandler.calledOnce).to.be.true;
  });

  it("should raise onBeforeShutdown events", async () => {
    await TestUtils.startBackend();
    const eventHandler = sinon.spy();
    IModelHost.onBeforeShutdown.addOnce(eventHandler);
    const filename = IModelTestUtils.resolveAssetFile("GetSetAutoHandledStructProperties.bim");

    const workspaceClose = sinon.spy((IModelHost.appWorkspace as any), "close");
    const saveSettings = IModelHost.appWorkspace.settings as any;
    const settingClose = sinon.spy(saveSettings, "close");
    expect(workspaceClose.callCount).eq(0);
    expect(settingClose.callCount).eq(0);
    expect(saveSettings._remove).to.not.be.undefined;

    // shutdown should close any opened iModels. Make sure that happens
    const imodel1 = SnapshotDb.openFile(filename, { key: "imodel1" });
    const imodel2 = SnapshotDb.openFile(filename, { key: "imodel2" });
    const imodel3 = SnapshotDb.openFile(filename, { key: "imodel3" });
    const imodel4 = SnapshotDb.openFile(filename, { key: "imodel4" });
    assert.notEqual(imodel1, imodel2);
    assert.notEqual(imodel2, imodel3);
    expect(imodel1.isOpen).to.be.true;
    expect(imodel2.isOpen).to.be.true;
    expect(imodel3.isOpen).to.be.true;
    imodel4.close(); // make sure it gets removed so we don't try to close it again on shutdown
    await TestUtils.shutdownBackend();
    expect(eventHandler.calledOnce).to.be.true;
    assert.isFalse(imodel1.isOpen, "shutdown should close iModel1");
    assert.isFalse(imodel2.isOpen, "shutdown should close iModel2");
    assert.isFalse(imodel3.isOpen, "shutdown should close iModel3");
    expect(workspaceClose.callCount).eq(1);
    expect(settingClose.callCount).eq(1);
    expect(saveSettings._remove).to.be.undefined;
  });

  it("should auto-shutdown on process beforeExit event", async () => {
    await TestUtils.startBackend();
    expect(IModelHost.isValid).to.be.true;
    const eventHandler = sinon.spy();
    IModelHost.onBeforeShutdown.addOnce(eventHandler);
    process.emit("beforeExit", 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(eventHandler.calledOnce).to.be.true;
    expect(IModelHost.isValid).to.be.false;
  });

  it("should set the briefcase cache directory to expected locations", async () => {
    const config: IModelHostOptions = {};
    const cacheSubDir = "imodels";

    // Test cache default location
    await IModelHost.shutdown();
    await IModelHost.startup(config);
    let expectedDir = path.join(IModelHost.cacheDir, cacheSubDir);
    assert.strictEqual(expectedDir, BriefcaseManager.cacheDir);

    // Test custom cache location
    await IModelHost.shutdown();
    config.cacheDir = KnownLocations.tmpdir;
    await IModelHost.startup(config);
    expectedDir = path.join(KnownLocations.tmpdir, cacheSubDir);
    assert.strictEqual(expectedDir, BriefcaseManager.cacheDir);
  });

  /* eslint-disable deprecation/deprecation */
  it("should set Azure cloud storage provider for tile cache given credentials", async () => {
    const config: IModelHostOptions = {};
    config.tileCacheAzureCredentials = {
      account: "testAccount",
      accessKey: "testAccessKey",
    };

    const setMaxTileCacheSizeStub = sinon.stub();
    sinon.stub(IModelHost, "platform").get(() => ({
      setMaxTileCacheSize: setMaxTileCacheSizeStub,
    }));

    await IModelHost.startup(config);

    assert.instanceOf(IModelHost.tileCacheService, AzureBlobStorage);
    assert.equal((IModelHost.tileCacheService as any)._credential.accountName, config.tileCacheAzureCredentials.account);
    assert.isDefined(IModelHost.tileStorage);
    assert.instanceOf(IModelHost.tileStorage!.storage, AzureServerStorage);
    assert.equal((IModelHost.tileStorage!.storage as any)._config.accountName, config.tileCacheAzureCredentials.account);
    assert.isTrue(setMaxTileCacheSizeStub.calledOnceWithExactly(0));
  });

  it("should set custom cloud storage provider for tile cache", async () => {
    const config: IModelHostOptions = {};
    config.tileCacheService = {} as AzureBlobStorage;
    config.tileCacheStorage = {} as ServerStorage;

    const setMaxTileCacheSizeStub = sinon.stub();
    sinon.stub(IModelHost, "platform").get(() => ({
      setMaxTileCacheSize: setMaxTileCacheSizeStub,
    }));

    await IModelHost.startup(config);

    assert.equal(IModelHost.tileCacheService, config.tileCacheService);
    assert.isDefined(IModelHost.tileStorage);
    assert.equal(IModelHost.tileStorage!.storage, config.tileCacheStorage);
    assert.isTrue(setMaxTileCacheSizeStub.calledOnceWithExactly(0));
  });

  it("should throw if both tileCacheService and tileCacheAzureCredentials are set", async () => {
    const config: IModelHostOptions = {};
    config.tileCacheAzureCredentials = {
      account: "testAccount",
      accessKey: "testAccessKey",
    };
    config.tileCacheService = {} as AzureBlobStorage;

    await expect(IModelHost.startup(config)).to.be.rejectedWith("Cannot use both Azure and custom cloud storage providers for tile cache.");
  });

  it("should throw if both tileCacheStorage and tileCacheAzureCredentials are set", async () => {
    const config: IModelHostOptions = {};
    config.tileCacheAzureCredentials = {
      account: "testAccount",
      accessKey: "testAccessKey",
    };
    config.tileCacheStorage = {} as ServerStorage;

    await expect(IModelHost.startup(config)).to.be.rejectedWith("Cannot use both Azure and custom cloud storage providers for tile cache.");
  });

  it("should use local cache if cloud storage provider for tile cache is not set", async () => {
    const setMaxTileCacheSizeStub = sinon.stub();
    sinon.stub(IModelHost, "platform").get(() => ({
      setMaxTileCacheSize: setMaxTileCacheSizeStub,
    }));

    await IModelHost.startup(opts);

    assert.isUndefined(IModelHost.tileCacheService);
    assert.isUndefined(IModelHost.tileUploader);
    assert.isTrue(setMaxTileCacheSizeStub.calledOnceWithExactly(IModelHostConfiguration.defaultMaxTileCacheDbSize));
  });

  it("should use configured size for local cache", async () => {
    const setMaxTileCacheSizeStub = sinon.stub();
    sinon.stub(IModelHost, "platform").get(() => ({
      setMaxTileCacheSize: setMaxTileCacheSizeStub,
    }));

    const maxTileCacheDbSize = 123456;
    await IModelHost.startup({
      ...opts,
      maxTileCacheDbSize,
    });

    assert.isUndefined(IModelHost.tileCacheService);
    assert.isUndefined(IModelHost.tileUploader);
    assert.isTrue(setMaxTileCacheSizeStub.calledOnceWithExactly(maxTileCacheDbSize));
  });

  it("should cleanup tileCacheService, tileStorageService and tileUploader on shutdown", async () => {
    const config: IModelHostOptions = {};
    config.tileCacheService = {} as AzureBlobStorage;
    config.tileCacheStorage = {} as ServerStorage;

    await IModelHost.startup(config);

    assert.equal(IModelHost.tileCacheService, config.tileCacheService);
    assert.equal(IModelHost.tileStorage?.storage, config.tileCacheStorage);
    assert.isDefined(IModelHost.tileUploader);

    await IModelHost.shutdown();

    assert.isUndefined(IModelHost.tileCacheService);
    assert.isUndefined(IModelHost.tileStorage);
    assert.isUndefined(IModelHost.tileUploader);
  });
  /* eslint-enable deprecation/deprecation */

  it("should throw if hubAccess is undefined and getter is called", async () => {
    await IModelHost.startup(opts);
    expect(IModelHost.getHubAccess()).undefined;
    expect(() => IModelHost.hubAccess).throws();
  });

  it("computeSchemaChecksum", () => {
    const assetsDir = path.join(KnownTestLocations.assetsDir, "ECSchemaOps");
    const schemaXmlPath = path.join(assetsDir, "SchemaA.ecschema.xml");
    let referencePaths = [assetsDir];
    let sha1 = IModelHost.computeSchemaChecksum({ schemaXmlPath, referencePaths });
    expect(sha1).equal("3ac6578060902aa0b8426b61d62045fdf7fa0b2b");

    expect(() => IModelHost.computeSchemaChecksum({ schemaXmlPath, referencePaths, exactMatch: true })).throws("Failed to read schema SchemaA.ecschema");

    referencePaths = [path.join(assetsDir, "exact-match")];
    sha1 = IModelHost.computeSchemaChecksum({ schemaXmlPath, referencePaths, exactMatch: true });
    expect(sha1).equal("2a618664fbba1df7c05f27d7c0e8f58de250003b");
  });
});
