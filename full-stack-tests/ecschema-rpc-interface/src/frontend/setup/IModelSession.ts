/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { expect } from "chai";
import { AuthorizedFrontendRequestContext, CheckpointConnection } from "@bentley/imodeljs-frontend";
import { IModelHubClient, IModelQuery } from "@bentley/imodelhub-client";
import { ContextRegistryClient, Project } from "@bentley/context-registry-client";
import { IModelData } from "../../common/Settings";

export class IModelSession {

  public iTwinId: string;
  public iModelId: string;
  public changesetId?: string;

  private _iModel?: CheckpointConnection;

  public constructor(iModelId: string, iTwinId: string, changesetId?: string) {
    this.iTwinId = iTwinId;
    this.iModelId = iModelId;
    this.changesetId = changesetId;
  }

  public static async create(requestContext: AuthorizedFrontendRequestContext, iModelData: IModelData): Promise<IModelSession> {
    let contextId;
    let imodelId;

    // Turn the project name into an id
    if (iModelData.useProjectName) {
      const client = new ContextRegistryClient();
      const project: Project = await client.getProject(requestContext, {
        $select: "*",
        $filter: `Name+eq+'${iModelData.projectName}'`,
      });
      contextId = project.wsgId;
    } else
      contextId = iModelData.projectId!;

    if (iModelData.useName) {
      const imodelClient = new IModelHubClient();
      const imodels = await imodelClient.iModels.get(requestContext, contextId, new IModelQuery().byName(iModelData.name!));
      if (undefined === imodels || imodels.length === 0)
        throw new Error(`The iModel ${iModelData.name} does not exist in project ${contextId}.`);
      imodelId = imodels[0].wsgId;
    } else
      imodelId = iModelData.id!;

    console.log(`Using iModel { name:${iModelData.name}, id:${iModelData.id}, projectId:${iModelData.projectId}, changesetId:${iModelData.changeSetId} }`); // eslint-disable-line no-console

    return new IModelSession(contextId, imodelId, iModelData.changeSetId);
  }

  public async getConnection(): Promise<CheckpointConnection> {
    return undefined === this._iModel ? this.open() : this._iModel;
  }

  public async open(): Promise<CheckpointConnection> {
    try {
      const env = process.env.IMJS_BUDDI_RESOLVE_URL_USING_REGION;
      // eslint-disable-next-line no-console
      console.log(`Environment: ${env}`);
      this._iModel = await CheckpointConnection.openRemote(this.iTwinId, this.iModelId);
      expect(this._iModel).to.exist;
    } catch (e) {
      throw new Error(`Failed to open test iModel. Error: ${e.message}`);
    }

    return this._iModel;
  }
}
