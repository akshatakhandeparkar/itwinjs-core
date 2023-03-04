/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import {
  Matrix3d, Point3d, Range3d, Transform, Vector3d,
} from "@itwin/core-geometry";
import { Tileset3dSchema as schema } from "@itwin/core-common";
import { IModelConnection, TileLoadPriority, RealityModelTileUtils } from "@itwin/core-frontend";
import { BatchedTileTreeParams } from "./BatchedTileTree";
import { BatchedTile, BatchedTileParams } from "./BatchedTile";

function isTileset3d(json: unknown): json is schema.Tileset {
  if (typeof "json" !== "object")
    return false;

  const props = json as schema.Tileset;
  return undefined !== props.root && undefined !== props.geometricError && undefined !== props.asset;
}

function rangeFromBoundingVolume(vol: schema.BoundingVolume): Range3d {
  if (vol.box) {
    const center = new Point3d(vol.box[0], vol.box[1], vol.box[2]);
    const ux = new Vector3d(vol.box[3], vol.box[4], vol.box[5]);
    const uy = new Vector3d(vol.box[6], vol.box[7], vol.box[8]);
    const uz = new Vector3d(vol.box[9], vol.box[10], vol.box[11]);

    const range = Range3d.createNull();
    for (let i = -1; i <= 1; i += 2)
      for (let j = -1; j <= 1; j += 2)
        for (let k = -1; k <= 1; k += 2)
          range.extendPoint(center.plus3Scaled(ux, i, uy, j, uz, k));

    return range;
  } else if (vol.sphere) {
    const center = new Point3d(vol.sphere[0], vol.sphere[1], vol.sphere[2]);
    const radius = vol.sphere[3];
    return Range3d.createXYZXYZ(center.x - radius, center.y - radius, center.z - radius, center.x + radius, center.y + radius, center.z + radius);
  }

  // We won't get region bounding volumes in our tiles.
  throw new Error("region bounding volume unimplemented");
}

function transformFromJSON(json: schema.Transform): Transform {
  const translation = new Point3d(json[12], json[13], json[14]);
  const matrix = Matrix3d.createRowValues(
    json[0], json[4], json[8],
    json[1], json[5], json[9],
    json[2], json[6], json[10]
  );

  return Transform.createOriginAndMatrix(translation, matrix);
}

export class BatchedTilesetReader {
  private readonly _iModel: IModelConnection;
  private readonly _tileset: schema.Tileset;

  public constructor(json: unknown, iModel: IModelConnection) {
    this._iModel = iModel;
    if (!isTileset3d(json))
      throw new Error("Invalid tileset JSON");

    this._tileset = json;
  }

    private readTileParams(json: schema.Tile, parent?: BatchedTile): BatchedTileParams {
    const content = json.content;
    const geometricError = json.geometricError;
    const range = rangeFromBoundingVolume(json.boundingVolume);

    return {
      parent,
      contentId: content?.uri ?? "",
      range,
      contentRange: content?.boundingVolume ? rangeFromBoundingVolume(content.boundingVolume) : undefined,
      isLeaf: !!(json.children?.length),
      maximumSize: RealityModelTileUtils.maximumSizeFromGeometricTolerance(range, geometricError),
    };
  }

  public async readTileTreeParams(): Promise<BatchedTileTreeParams> {
    const root = this._tileset.root;
    const location = root.transform ? transformFromJSON(root.transform) : Transform.createIdentity();

    return {
      id: "spatial-models",
      modelId: this._iModel.transientIds.getNext(),
      iModel: this._iModel,
      location,
      priority: TileLoadPriority.Primary,
      rootTile: this.readTileParams(root),
      reader: this,
    };
  }
}
