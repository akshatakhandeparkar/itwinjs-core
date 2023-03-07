/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { registerBackendCallback } from "@itwin/certa/lib/utils/CallbackUtils";
import { BentleyCloudRpcConfiguration, BentleyCloudRpcManager, BentleyCloudRpcParams } from "@itwin/core-common";
import { MobileHost } from "@itwin/core-mobile/lib/cjs/MobileBackend";
import { BackendTestCallbacks } from "../common/SideChannels";
import { AttachedInterface, rpcInterfaces } from "../common/TestRpcInterface";
import { commonSetup } from "./CommonBackendSetup";
import { initializeMockMobileTest, setupMockMobileTest } from "./mockmobile";
import { initializeWebRoutingTest } from "./routing";
import { AttachedInterfaceImpl } from "./TestRpcImpl";
import { TestServer } from "./TestServer";

async function init() {
  const port = Number(process.env.CERTA_PORT || 3021) + 2000;
  const mobilePort = port + 2000;
  await setupMockMobileTest(mobilePort);

  await commonSetup();
  registerBackendCallback(BackendTestCallbacks.getEnvironment, () => "http");

  const paramsHolder = BentleyCloudRpcParams.wrap({ info: { title: "rpc-full-stack-test", version: "v1.0" } });
  const rpcConfigHolder = BentleyCloudRpcManager.initializeImpl(paramsHolder, rpcInterfaces);

  // create a basic express web server
  const testServer = new TestServer(rpcConfigHolder.configuration.protocol);
  const httpServer = await testServer.initialize(port);

  // eslint-disable-next-line no-console
  console.log(`Web backend for rpc full-stack-tests listening on port ${port}`);

  initializeAttachedInterfacesTest(rpcConfigHolder.configuration);
  initializeWebRoutingTest(rpcConfigHolder.configuration.protocol);

  await initializeMockMobileTest();

  // eslint-disable-next-line no-console
  console.log(`Mobile backend for rpc full-stack-tests listening on port ${mobilePort}`);
  return () => {
    httpServer.close();
    MobileHost.onWillTerminate.raiseEvent();
  };
}

function initializeAttachedInterfacesTest(config: BentleyCloudRpcConfiguration) {
  AttachedInterfaceImpl.register();
  config.attach(AttachedInterface);
}

module.exports = init();
