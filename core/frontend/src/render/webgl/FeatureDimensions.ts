/*---------------------------------------------------------------------------------------------
| $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
/** @module WebGL */

import { assert } from "@bentley/bentleyjs-core";
import { FeatureIndexType } from "@bentley/imodeljs-common";
import { System } from "./System";

/** Describes the dimensionality of a texture used as a look-up table. */
export const enum LUTDimension {
  Uniform, //  uniform lookup table
  NonUniform, // 1- or 2-dimensional lookup table
}

/** Describes the dimensions of a texture used as a look-up table */
export class LUTDimensions {
  public readonly width: number;
  public readonly height: number;

  public constructor(nEntries: number, nRgbaPerEntry: number, nExtraRgba: number = 0, nTables: number = 1) {
    const maxSize = System.instance.capabilities.maxTextureSize;
    const nRgba = nEntries * nRgbaPerEntry * nTables + nExtraRgba;

    if (nRgba < maxSize) {
      this.width = nRgba;
      this.height = 1;
      return;
    }

    // Make roughly square to reduce unused space in last row
    let width = Math.ceil(Math.sqrt(nRgba));

    // Ensure a given entry's RGBA values all fit on the same row.
    const remainder = width % nRgbaPerEntry;
    if (0 !== remainder) {
      width += nRgbaPerEntry - remainder;
    }

    // Compute height
    const height = Math.ceil(nRgba / width);

    assert(height <= maxSize);
    assert(width <= maxSize);
    assert(width * height >= nRgba);
    assert(Math.floor(height) === height);
    assert(Math.floor(width) === width);

    // Row padding should never be necessary...
    assert(0 === width % nRgbaPerEntry);

    this.width = width;
    this.height = height;
  }
}

export const enum FeatureDimension {
  Empty,
  SingleUniform,
  SingleNonUniform,
  Multiple,
  COUNT,
}

export function getFeatureName(dim: FeatureDimension): string {
  switch (dim) {
    case FeatureDimension.Empty: return "Empty";
    case FeatureDimension.SingleUniform: return "Single/Uniform";
    case FeatureDimension.SingleNonUniform: return "Single/Non-uniform";
    case FeatureDimension.Multiple: return "Multiple";
    default: assert(false); return "Invalid";
  }
}

export function computeFeatureDimension(dim: LUTDimension, type: FeatureIndexType) {
  switch (type) {
    case FeatureIndexType.Empty:
      return FeatureDimension.Empty;
    case FeatureIndexType.NonUniform:
      assert(LUTDimension.Uniform !== dim);
      return FeatureDimension.Multiple;
    default:
      return LUTDimension.Uniform === dim ? FeatureDimension.SingleUniform : FeatureDimension.SingleNonUniform;
  }
}
