/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import { assert } from "chai";
import { ChildProcess } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import { AccessToken, GuidString } from "@itwin/core-bentley";
import { CheckpointV2Query } from "@bentley/imodelhub-client";
import { ChangesetProps } from "@itwin/core-common";
import { BlobDaemon } from "@bentley/imodeljs-native";
import { TestUsers, TestUtility } from "@itwin/oidc-signin-tool";
import { IModelHubBackend } from "../../IModelHubBackend";
import { IModelHost, IModelJsFs, SnapshotDb } from "../../core-backend";
import { KnownTestLocations } from "../KnownTestLocations";
import { HubUtility } from "./HubUtility";

describe("Checkpoints (#integration)", () => {
  let user: AccessToken;
  let testIModelId: GuidString;
  let testITwinId: GuidString;
  let testChangeSet: ChangesetProps;

  const blockcacheDir = path.join(KnownTestLocations.outputDir, "blockcachevfs");
  let daemonProc: ChildProcess;
  let originalEnv: any;

  before(async () => {
    originalEnv = { ...process.env };
    process.env.BLOCKCACHE_DIR = blockcacheDir;
    // IModelTestUtils.setupDebugLogLevels();

    user = await TestUtility.getAccessToken(TestUsers.regular);
    testITwinId = await HubUtility.getTestITwinId(user);
    testIModelId = await HubUtility.getTestIModelId(user, HubUtility.testIModelNames.stadium);
    testChangeSet = await IModelHost.hubAccess.getLatestChangeset({ user, iModelId: testIModelId });

    const checkpointQuery = new CheckpointV2Query().byChangeSetId(testChangeSet.id).selectContainerAccessKey();
    const checkpoints = await IModelHubBackend.iModelClient.checkpointsV2.get(user, testIModelId, checkpointQuery);
    assert.equal(checkpoints.length, 1, "checkpoint missing");
    assert.isDefined(checkpoints[0].containerAccessKeyAccount, "checkpoint storage account is invalid");

    // Start daemon process and wait for it to be ready
    fs.chmodSync((BlobDaemon as any).exeName({}), 744);  // FIXME: This probably needs to be an imodeljs-native postinstall step...
    daemonProc = BlobDaemon.start({
      daemonDir: blockcacheDir,
      storageType: "azure?sas=1",
      user: checkpoints[0].containerAccessKeyAccount!,
    });
    while (!IModelJsFs.existsSync(path.join(blockcacheDir, "portnumber.bcv"))) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  after(async () => {
    process.env = originalEnv;

    if (daemonProc) {
      const onDaemonExit = new Promise((resolve) => daemonProc.once("exit", resolve));
      daemonProc.kill();
      await onDaemonExit;
    }
    fs.removeSync(blockcacheDir);
  });

  it("should be able to open and read V2 checkpoint", async () => {
    const iModel = await SnapshotDb.openCheckpointV2({
      user,
      iTwinId: testITwinId,
      iModelId: testIModelId,
      changeset: testChangeSet,
    });
    assert.equal(iModel.iModelId, testIModelId);
    assert.equal(iModel.changeset.id, testChangeSet.id);
    assert.equal(iModel.iTwinId, testITwinId);
    assert.equal(iModel.rootSubject.name, "Stadium Dataset 1");
    let numModels = await iModel.queryRowCount("SELECT * FROM bis.model");
    assert.equal(numModels, 32);

    await iModel.reattachDaemon(user);
    numModels = await iModel.queryRowCount("SELECT * FROM bis.model");
    assert.equal(numModels, 32);

    iModel.close();
  }).timeout(120000);
});
