/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { ProcessDetector } from "@itwin/core-bentley";
import { IpcWebSocketFrontend } from "@itwin/core-common";
import { executeBackendCallback } from "@itwin/certa/lib/utils/CallbackUtils";
import { assert } from "chai";
import { BackendTestCallbacks } from "../common/SideChannels";
import { currentEnvironment } from "./_Setup.test";

if (!ProcessDetector.isElectronAppFrontend) {
  describe("IpcWebSocket", () => {
    let socket: IpcWebSocketFrontend;

    before(async () => {
      if (currentEnvironment === "websocket") {
        return;
      }

      assert(await executeBackendCallback(BackendTestCallbacks.startIpcTest));
      socket = new IpcWebSocketFrontend();
    });

    it("should support send/receive", async () => {
      if (currentEnvironment === "websocket") {
        return;
      }

      return new Promise(async (resolve) => {
        socket.addListener("test", (_evt: Event, ...arg: any[]) => {
          assert.equal(arg[0], 4);
          assert.equal(arg[1], 5);
          assert.equal(arg[2], 6);
          resolve();
        });

        socket.send("test", 1, 2, 3);

        assert(await executeBackendCallback(BackendTestCallbacks.sendIpcMessage));
      });
    });

    it("should support invoke", async () => {
      if (currentEnvironment === "websocket") {
        return;
      }

      return new Promise(async (resolve) => {
        const invoked = await socket.invoke("testinvoke", "hi", 1, 2, 3);
        assert.equal(invoked[0], "hi");
        assert.equal(invoked[1], 1);
        assert.equal(invoked[2], 2);
        assert.equal(invoked[3], 3);
        resolve();
      });
    });
  });
}
