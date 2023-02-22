/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Tiles
 */

import {
  assert, ByteStream, compareBooleans, compareNumbers, compareStrings, Dictionary, JsonUtils, Logger, utf8ToString,
} from "@itwin/core-bentley";
import {
  Angle, IndexedPolyface, Matrix3d, Point2d, Point3d, Point4d, Polyface, Range2d, Range3d, Transform, Vector3d,
} from "@itwin/core-geometry";
import {
  BatchType, ColorDef, ElementAlignedBox3d, Feature, FeatureTable, FillFlags, GlbHeader, ImageSource, LinePixels, MeshEdge,
  MeshEdges, MeshPolyline, MeshPolylineList, OctEncodedNormal, PackedFeatureTable, QParams2d, QParams3d, QPoint2dList,
  QPoint3dList, Quantization, RenderMaterial, RenderTexture, TextureMapping, TextureTransparency, TileFormat, TileReadStatus,
} from "@itwin/core-common";
import { FrontendLoggerCategory } from "../FrontendLoggerCategory";
import { getImageSourceFormatForMimeType, imageBitmapFromImageSource, imageElementFromImageSource, tryImageElementFromUrl } from "../ImageUtil";
import { IModelConnection } from "../IModelConnection";
import { IModelApp } from "../IModelApp";
import { GraphicBranch } from "../render/GraphicBranch";
import { PickableGraphicOptions } from "../render/GraphicBuilder";
import { InstancedGraphicParams } from "../render/InstancedGraphicParams";
import { RealityMeshParams } from "../render/RealityMeshParams";
import { DisplayParams } from "../render/primitives/DisplayParams";
import { Mesh } from "../render/primitives/mesh/MeshPrimitives";
import { Triangle } from "../render/primitives/Primitives";
import { RenderGraphic } from "../render/RenderGraphic";
import { RenderSystem } from "../render/RenderSystem";
import { RealityTileGeometry, TileContent } from "./internal";
import type { DracoLoader, DracoMesh } from "@loaders.gl/draco";
import { TextureImageSource } from "../render/RenderTexture";
import { CreateRenderMaterialArgs } from "../render/RenderMaterial";
import {
  DracoMeshCompression, getGltfNodeMeshIds, GltfAccessor, GltfBuffer, GltfBufferViewProps, GltfDataType, GltfDictionary, gltfDictionaryIterator, GltfDocument, GltfId,
  GltfImage, GltfMaterial, GltfMesh, GltfMeshMode, GltfMeshPrimitive, GltfNode, GltfSampler, GltfScene, GltfTechniqueState, GltfTexture, GltfWrapMode, isGltf1Material,
} from "../gltf/GltfSchema";

/* eslint-disable no-restricted-syntax */

/** @internal */
export type GltfDataBuffer = Uint8Array | Uint16Array | Uint32Array | Float32Array;

/**
 * A chunk of binary data exposed as a typed array.
 * The count member indicates how many elements exist. This may be less than this.buffer.length due to padding added to the
 * binary stream to ensure correct alignment.
 * @internal
 */
export class GltfBufferData {
  public readonly buffer: GltfDataBuffer;
  public readonly count: number;

  public constructor(buffer: GltfDataBuffer, count: number) {
    this.buffer = buffer;
    this.count = count;
  }

  /**
   * Create a GltfBufferData of the desired type. The actual type may differ from the desired type - for example, small 32-bit integers
   * may be represented as 8-bit or 16-bit integers instead.
   * If the actual data type is not convertible to the desired type, this function returns undefined.
   */
  public static create(bytes: Uint8Array, actualType: GltfDataType, expectedType: GltfDataType, count: number): GltfBufferData | undefined {
    if (expectedType !== actualType) {
      // Some data is stored in smaller data types to save space if no values exceed the maximum of the smaller type.
      switch (expectedType) {
        case GltfDataType.Float:
        case GltfDataType.UnsignedByte:
          return undefined;
        case GltfDataType.UnsignedShort:
          if (GltfDataType.UnsignedByte !== actualType)
            return undefined;
          break;
        case GltfDataType.UInt32:
          if (GltfDataType.UnsignedByte !== actualType && GltfDataType.UnsignedShort !== actualType)
            return undefined;
          break;
      }
    }

    const data = this.createDataBuffer(bytes, actualType);
    return undefined !== data ? new GltfBufferData(data, count) : undefined;
  }

  private static createDataBuffer(bytes: Uint8Array, actualType: GltfDataType): GltfDataBuffer | undefined {
    // NB: Endianness of typed array data is determined by the 'platform byte order'. Actual data is always little-endian.
    // We are assuming little-endian platform. If we find a big-endian platform, we'll need to use a DataView instead.
    switch (actualType) {
      case GltfDataType.UnsignedByte:
        return bytes;
      case GltfDataType.UnsignedShort:
        return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      case GltfDataType.UInt32:
        return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      case GltfDataType.Float:
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      default:
        return undefined;
    }
  }
}

/**
 * A view of a chunk of glTF binary data containing an array of elements of a specific data type.
 * The count member indicates how many elements exist; this may be smaller than this.data.length.
 * The count member may also indicate the number of elements of a type containing more than one value of the
 * underlying type. For example, a buffer of 4 32-bit floating point 'vec2' elements will have a count of 4,
 * but its data member will contain 8 32-bit floating point values (2 per vec2).
 * The accessor member may contain additional JSON data specific to a particular buffer.
 * @internal
 */
class GltfBufferView {
  public readonly data: Uint8Array;
  public readonly count: number;
  public readonly type: GltfDataType;
  public readonly accessor: GltfAccessor;
  public readonly stride: number;

  public get byteLength(): number { return this.data.length; }

  public constructor(data: Uint8Array, count: number, type: GltfDataType, accessor: GltfAccessor, stride: number) {
    this.data = data;
    this.count = count;
    this.type = type;
    this.accessor = accessor;
    this.stride = stride;
  }

  public toBufferData(desiredType: GltfDataType): GltfBufferData | undefined {
    return GltfBufferData.create(this.data, this.type, desiredType, this.count);
  }
}

/* -----------------------------------
 * To restore the use of web workers to decode jpeg, locate and uncomment the three sections by searching for "webworker".
  import { WorkerOperation, WebWorkerManager } from "../WebWorkerManager";
  ------------------------------------ */

/** The result of [[GltfReader.read]].
 * @internal
 */
export interface GltfReaderResult extends TileContent {
  readStatus: TileReadStatus;
}

/** Data required for creating a [[GltfReader]] capable of deserializing [glTF](https://www.khronos.org/gltf/).
 * @internal
 */
export class GltfReaderProps {
  public readonly version: number;
  public readonly glTF: GltfDocument;
  public readonly yAxisUp: boolean;
  public readonly binaryData?: Uint8Array;
  public readonly baseUrl?: string;

  private constructor(glTF: GltfDocument, version: number, yAxisUp: boolean, binaryData: Uint8Array | undefined, baseUrl?: string | undefined) {
    this.version = version;
    this.glTF = glTF;
    this.binaryData = binaryData;
    this.yAxisUp = yAxisUp;
    this.baseUrl = baseUrl;
  }

  /** Attempt to construct a new GltfReaderProps from the binary data beginning at the supplied stream's current read position. */
  public static create(source: Uint8Array | GltfDocument, yAxisUp: boolean = false, baseUrl?: string): GltfReaderProps | undefined {
    let version: number;
    let json: GltfDocument;
    let binaryData: Uint8Array | undefined;

    if (source instanceof Uint8Array) {
      // It may be JSON - check for magic indicating glb.
      const buffer = ByteStream.fromUint8Array(source);
      if (TileFormat.Gltf !== buffer.readUint32()) {
        try {
          const utf8Json = utf8ToString(source);
          if (!utf8Json)
            return undefined;

          json = JSON.parse(utf8Json);
          version = 2;
        } catch (_) {
          return undefined;
        }
      } else {
        buffer.reset();
        const header = new GlbHeader(buffer);
        if (!header.isValid)
          return undefined;

        version = header.version;
        if (header.binaryChunk)
          binaryData = new Uint8Array(source.buffer, source.byteOffset + header.binaryChunk.offset, header.binaryChunk.length);

        try {
          const jsonBytes = new Uint8Array(source.buffer, source.byteOffset + header.jsonChunk.offset, header.jsonChunk.length);
          const jsonStr = utf8ToString(jsonBytes);
          if (undefined === jsonStr)
            return undefined;

          json = JSON.parse(jsonStr);
        } catch (_) {
          return undefined;
        }
      }
    } else {
      version = 2; // ###TODO verify against source.asset?.version
      json = source;
    }

    // asset is required in glTF 2, optional in glTF 1
    const asset = JsonUtils.asObject(json.asset);
    if (version === 2 && !asset)
      return undefined;

    const glTF: GltfDocument = {
      asset,
      scene: JsonUtils.asString(json.scene),
      extensions: JsonUtils.asObject(json.extensions),
      extensionsUsed: JsonUtils.asArray(json.extensionsUsed),
      extensionsRequired: JsonUtils.asArray(json.extensionsRequired),
      accessors: JsonUtils.asObject(json.accessors),
      buffers: JsonUtils.asObject(json.buffers),
      bufferViews: JsonUtils.asObject(json.bufferViews),
      images: JsonUtils.asObject(json.images),
      materials: JsonUtils.asObject(json.materials),
      meshes: JsonUtils.asObject(json.meshes),
      nodes: JsonUtils.asObject(json.nodes),
      samplers: JsonUtils.asObject(json.samplers),
      scenes: JsonUtils.asObject(json.scenes),
      textures: JsonUtils.asObject(json.textures),
      techniques: JsonUtils.asObject(json.techniques),
    };

    return glTF.meshes ? new GltfReaderProps(glTF, version, yAxisUp, binaryData, baseUrl) : undefined;
  }
}

/** The GltfMeshData contains the raw GLTF mesh data. If the data is suitable to create a [[RealityMesh]] directly, basically in the quantized format produced by
  * ContextCapture, then a RealityMesh is created directly from this data. Otherwise, the mesh primitive is populated from the raw data and a MeshPrimitive
  * is generated. The MeshPrimitve path is much less efficient but should be rarely used.
  *
  * @internal
  */
export class GltfMeshData {
  public primitive: Mesh;       // Populated with vertex and indices only if the mesh cannot be represented as [[RealityMesh]]
  public pointQParams?: QParams3d;
  public points?: Uint16Array;
  public pointRange?: Range3d;
  public normals?: Uint16Array;
  public uvQParams?: QParams2d;
  public uvs?: Uint16Array;
  public uvRange?: Range2d;
  public indices?: Uint8Array | Uint16Array | Uint32Array;

  public constructor(props: Mesh) {
    this.primitive = props;
  }
}

/** A function that returns true if deserialization of the data supplied by the reader should abort.
 * @internal
 */
export type ShouldAbortReadGltf = (reader: GltfReader) => boolean;

/* -----------------------------------
   This is part of the webworker option.

  // input is Uint8Array, the result is an ImageBitMap.
  class ImageDecodeWorkerOperation extends WorkerOperation {
    constructor(imageBytes: ArrayBuffer, imageMimeType: string) {
      super("imageBytesToImageBitmap", [imageBytes, imageMimeType], [imageBytes]);
    }
  }
-------------------------------------- */

const emptyDict = { };

function colorFromJson(values: number[]): ColorDef {
  return ColorDef.from(values[0] * 255, values[1] * 255, values[2] * 255, (1.0 - values[3]) * 255);
}

function colorFromMaterial(material: GltfMaterial, isTransparent: boolean): ColorDef {
  let color = ColorDef.white;
  if (isGltf1Material(material)) {
    if (material.values?.color && Array.isArray(material.values.color))
      color = colorFromJson(material.values.color);
  } else if (material.extensions?.KHR_techniques_webgl?.values?.u_color) {
    color = colorFromJson(material.extensions.KHR_techniques_webgl.values.u_color);
  } else if (material.pbrMetallicRoughness?.baseColorFactor) {
    color = colorFromJson(material.pbrMetallicRoughness.baseColorFactor);
  }

  // SPEC: Opaque materials ignore any alpha channel.
  if (!isTransparent)
    color = color.withTransparency(0);

  return color;
}

class TransformStack {
  private readonly _stack: Array<Transform | undefined> = [];

  public constructor(transform?: Transform) {
    if (transform)
      this._stack.push(transform);
  }

  public get transform(): Transform | undefined {
    return this._stack.length > 0 ? this._stack[this._stack.length - 1] : undefined;
  }

  public get isEmpty(): boolean {
    return 0 === this._stack.length;
  }

  public push(node: GltfNode): void {
    let nodeTransform;
    if (node.matrix) {
      const origin = Point3d.create(node.matrix[12], node.matrix[13], node.matrix[14]);
      const matrix = Matrix3d.createRowValues(
        node.matrix[0], node.matrix[4], node.matrix[8],
        node.matrix[1], node.matrix[5], node.matrix[9],
        node.matrix[2], node.matrix[6], node.matrix[10],
      );

      nodeTransform = Transform.createOriginAndMatrix(origin, matrix);
    } else if (node.rotation || node.scale || node.translation) {
      // SPEC: To compose the local transformation matrix, TRS properties MUST be converted to matrices and postmultiplied in the T * R * S order;
      // first the scale is applied to the vertices, then the rotation, and then the translation.
      const scale = Transform.createRefs(undefined, node.scale ? Matrix3d.createScale(node.scale[0], node.scale[1], node.scale[2]) : Matrix3d.identity);
      const rot = Transform.createRefs(undefined, node.rotation ? Matrix3d.createFromQuaternion(Point4d.create(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3])) : Matrix3d.identity);
      rot.matrix.transposeInPlace(); // See comment on Matrix3d.createFromQuaternion
      const trans = Transform.createTranslation(node.translation ? new Point3d(node.translation[0], node.translation[1], node.translation[2]) : Point3d.createZero());

      nodeTransform = scale.multiplyTransformTransform(rot);
      trans.multiplyTransformTransform(nodeTransform, nodeTransform);
    }

    const top = this.transform;
    if (!top)
      this._stack.push(nodeTransform);
    else
      this._stack.push(nodeTransform ? top.multiplyTransformTransform(nodeTransform) : top);
  }

  public pop(): void {
    assert(this._stack.length > 0);
    this._stack.pop();
  }
}

/** Arguments to [[GltfReader]] constructor.
 * @internal
 */
export interface GltfReaderArgs {
  /** Properties of the glTF source. */
  props: GltfReaderProps;
  /** The iModel with which the graphics are to be associated. */
  iModel: IModelConnection;
  /** If true, create 2d graphics. */
  is2d?: boolean;
  /** The render system that will produce the graphics. Defaults to [[IModelApp.renderSystem]]. */
  system?: RenderSystem;
  /** The type of batch to create. Defaults to [BatchType.Primary]($common).
   * @see [[RenderSystem.createBatch]].
   */
  type?: BatchType;
  /** An optional function that, if supplied, is invoked periodically to determine if the process of producing graphics from the glTF should terminate early. */
  shouldAbort?: ShouldAbortReadGltf;
  /** If true, each vertex in the graphics should belong to exactly one triangle. This is less efficient than sharing vertices between adjoining triangles, but
   * sometimes required - for example, for [ViewFlags.wiremesh]($common).
   */
  deduplicateVertices?: boolean;
  /** If true, the graphics produced will always use a [[VertexTable]]; otherwise, where possible a [[RealityMeshParams]] will be used instead.
   * Reality meshes are simpler but do not support some features like lighting.
   */
  vertexTableRequired?: boolean;
}

function * traverseNodes(ids: Iterable<GltfId>, nodes: GltfDictionary<GltfNode>, traversed: Set<GltfId>): Iterable<GltfNode> {
  for (const id of ids) {
    if (traversed.has(id))
      throw new Error("Cycle detected while traversing glTF nodes");

    const node = nodes[id];
    if (!node)
      continue;

    traversed.add(id);
    yield node;
    if (node.children)
      for (const child of traverseNodes(node.children, nodes, traversed))
        yield child;
  }
}

interface TextureKey {
  readonly id: GltfId;
  readonly isTransparent: boolean;
}

function compareTextureKeys(lhs: TextureKey, rhs: TextureKey): number {
  const cmp = compareBooleans(lhs.isTransparent, rhs.isTransparent);
  if (0 !== cmp)
    return cmp;

  assert(typeof lhs.id === typeof rhs.id);
  if ("string" === typeof lhs.id) {
    assert("string" === typeof rhs.id);
    return compareStrings(lhs.id, rhs.id);
  }

  assert("number" === typeof lhs.id && "number" === typeof rhs.id);
  return compareNumbers(lhs.id, rhs.id);
}

/** Deserializes [glTF](https://www.khronos.org/gltf/).
 * @internal
 */
export abstract class GltfReader {
  protected readonly _glTF: GltfDocument;
  protected readonly _version: number;
  protected readonly _iModel: IModelConnection;
  protected readonly _is3d: boolean;
  protected readonly _system: RenderSystem;
  protected readonly _returnToCenter?: Point3d;
  protected readonly _yAxisUp: boolean;
  protected readonly _baseUrl?: string;
  protected readonly _type: BatchType;
  protected readonly _deduplicateVertices: boolean;
  protected readonly _vertexTableRequired: boolean;
  private readonly _canceled?: ShouldAbortReadGltf;
  protected readonly _sceneNodes: GltfId[];
  protected _computedContentRange?: ElementAlignedBox3d;
  private readonly _resolvedTextures = new Dictionary<TextureKey, RenderTexture | false>((lhs, rhs) => compareTextureKeys(lhs, rhs));
  private readonly _dracoMeshes = new Map<DracoMeshCompression, DracoMesh>();

  protected get _nodes(): GltfDictionary<GltfNode> { return this._glTF.nodes ?? emptyDict; }
  protected get _meshes(): GltfDictionary<GltfMesh> { return this._glTF.meshes ?? emptyDict; }
  protected get _accessors(): GltfDictionary<GltfAccessor> { return this._glTF.accessors ?? emptyDict; }
  protected get _bufferViews(): GltfDictionary<GltfBufferViewProps> { return this._glTF.bufferViews ?? emptyDict; }
  protected get _materials(): GltfDictionary<GltfMaterial> { return this._glTF.materials ?? emptyDict; }
  protected get _samplers(): GltfDictionary<GltfSampler> { return this._glTF.samplers ?? emptyDict; }
  protected get _textures(): GltfDictionary<GltfTexture> { return this._glTF.textures ?? emptyDict; }

  protected get _images(): GltfDictionary<GltfImage & { resolvedImage?: TextureImageSource }> { return this._glTF.images ?? emptyDict; }
  protected get _buffers(): GltfDictionary<GltfBuffer & { resolvedBuffer?: Uint8Array }> { return this._glTF.buffers ?? emptyDict; }

  /* -----------------------------------
  private static _webWorkerManager: WebWorkerManager;

  private static get webWorkerManager() {
    if (!GltfReader._webWorkerManager) {
      GltfReader._webWorkerManager = new WebWorkerManager("v" + BUILD_SEMVER + "/frontend-webworker.js", 4);
    }
    return GltfReader._webWorkerManager;
  }
  ------------------------------------- */

  /** Asynchronously deserialize the tile data and return the result. */
  public abstract read(): Promise<GltfReaderResult>;

  protected get _isCanceled(): boolean { return undefined !== this._canceled && this._canceled(this); }
  protected get _isVolumeClassifier(): boolean { return BatchType.VolumeClassifier === this._type; }

  /** Traverse the nodes specified by their Ids, recursing into their child nodes.
   * @param nodeIds The Ids of the nodes to traverse.
   * @throws Error if a node appears more than once during traversal
   */
  public traverseNodes(nodeIds: Iterable<GltfId>): Iterable<GltfNode> {
    return traverseNodes(nodeIds, this._nodes, new Set<GltfId>());
  }

  /** Traverse the nodes specified by their scene, recursing into their child nodes.
   * @throws Error if a node appears more than once during traversal
   */
  public traverseScene(): Iterable<GltfNode> {
    return this.traverseNodes(this._sceneNodes);
  }

  private getTileTransform(transformToRoot?: Transform, pseudoRtcBias?: Vector3d): Transform | undefined {
    let transform;

    if (this._returnToCenter || pseudoRtcBias || this._yAxisUp || transformToRoot) {
      if (this._returnToCenter)
        transform = Transform.createTranslation(this._returnToCenter.clone());
      else if (pseudoRtcBias)
        transform = Transform.createTranslationXYZ(pseudoRtcBias.x, pseudoRtcBias.y, pseudoRtcBias.z);
      else
        transform = Transform.createIdentity();

      if (this._yAxisUp)
        transform = transform.multiplyTransformMatrix3d(Matrix3d.createRotationAroundVector(Vector3d.create(1.0, 0.0, 0.0), Angle.createRadians(Angle.piOver2Radians)) as Matrix3d);

      if (transformToRoot)
        transform = transformToRoot.multiplyTransformTransform(transform);
    }

    return transform;
  }

  protected readGltfAndCreateGraphics(isLeaf: boolean, featureTable: FeatureTable | undefined, contentRange: ElementAlignedBox3d | undefined, transformToRoot?: Transform, pseudoRtcBias?: Vector3d, instances?: InstancedGraphicParams): GltfReaderResult {
    if (this._isCanceled)
      return { readStatus: TileReadStatus.Canceled, isLeaf };

    // If contentRange was not supplied, we will compute it as we read the meshes.
    if (!contentRange)
      this._computedContentRange = contentRange = Range3d.createNull();
    else
      this._computedContentRange = undefined;

    // ###TODO this looks like a hack? Why does it assume the first node's transform is special, or that the transform will be specified as a matrix instead of translation+rot+scale?
    if (this._returnToCenter || this._nodes[0]?.matrix || (pseudoRtcBias && pseudoRtcBias.magnitude() < 1.0E5))
      pseudoRtcBias = undefined;

    const transformStack = new TransformStack();
    const renderGraphicList: RenderGraphic[] = [];
    let readStatus: TileReadStatus = TileReadStatus.InvalidTileData;
    for (const nodeKey of this._sceneNodes) {
      assert(transformStack.isEmpty);
      const node = this._nodes[nodeKey];
      if (node && TileReadStatus.Success !== (readStatus = this.readNodeAndCreateGraphics(renderGraphicList, node, featureTable, transformStack, instances, pseudoRtcBias)))
        return { readStatus, isLeaf };
    }

    if (0 === renderGraphicList.length)
      return { readStatus: TileReadStatus.InvalidTileData, isLeaf };

    let renderGraphic: RenderGraphic | undefined;
    if (1 === renderGraphicList.length)
      renderGraphic = renderGraphicList[0];
    else
      renderGraphic = this._system.createGraphicList(renderGraphicList);

    const transform = this.getTileTransform(transformToRoot, pseudoRtcBias);
    let range = contentRange;
    const invTransform = transform?.inverse();
    if (invTransform)
      range = invTransform.multiplyRange(contentRange);

    if (featureTable)
      renderGraphic = this._system.createBatch(renderGraphic, PackedFeatureTable.pack(featureTable), range);

    if (transform) {
      const branch = new GraphicBranch(true);
      branch.add(renderGraphic);
      renderGraphic = this._system.createBranch(branch, transform);
    }

    return {
      readStatus,
      isLeaf,
      contentRange,
      graphic: renderGraphic,
    };
  }

  public readGltfAndCreateGeometry(transformToRoot?: Transform, needNormals = false, needParams = false): RealityTileGeometry {
    const transformStack = new TransformStack(this.getTileTransform(transformToRoot));
    const polyfaces: Polyface[] = [];
    for (const nodeKey of this._sceneNodes) {
      const node = this._nodes[nodeKey];
      if (node)
        this.readNodeAndCreatePolyfaces(polyfaces, node, transformStack, needNormals, needParams);
    }

    return { polyfaces };
  }

  private graphicFromMeshData(gltfMesh: GltfMeshData, instances?: InstancedGraphicParams): RenderGraphic | undefined {
    if (!gltfMesh.points || !gltfMesh.pointRange)
      return gltfMesh.primitive.getGraphics(this._system, instances);

    const realityMeshPrimitive = (this._vertexTableRequired || instances) ? undefined : RealityMeshParams.fromGltfMesh(gltfMesh);
    if (realityMeshPrimitive) {
      const realityMesh = this._system.createRealityMesh(realityMeshPrimitive);
      if (realityMesh)
        return realityMesh;
    }

    const mesh = gltfMesh.primitive;
    const pointCount = gltfMesh.points.length / 3;
    assert(mesh.points instanceof QPoint3dList);
    mesh.points.fromTypedArray(gltfMesh.pointRange, gltfMesh.points);
    if (mesh.triangles && gltfMesh.indices)
      mesh.triangles.addFromTypedArray(gltfMesh.indices);

    if (gltfMesh.uvs && gltfMesh.uvRange && gltfMesh.uvQParams) {
      /** This is ugly and inefficient... unnecessary if Mesh stored uvs as QPoint2dList */
      for (let i = 0, j = 0; i < pointCount; i++)
        mesh.uvParams.push(gltfMesh.uvQParams.unquantize(gltfMesh.uvs[j++], gltfMesh.uvs[j++]));
    }

    if (gltfMesh.normals)
      for (const normal of gltfMesh.normals)
        mesh.normals.push(new OctEncodedNormal(normal));

    return mesh.getGraphics(this._system, instances);
  }

  private readNodeAndCreateGraphics(renderGraphicList: RenderGraphic[], node: GltfNode, featureTable: FeatureTable | undefined, transformStack: TransformStack, instances?: InstancedGraphicParams, pseudoRtcBias?: Vector3d): TileReadStatus {
    if (undefined === node)
      return TileReadStatus.InvalidTileData;

    // IMPORTANT: Do not return without popping this node from the stack.
    transformStack.push(node);
    const thisTransform = transformStack.transform;

    /**
     * This is a workaround for tiles generated by
     * context capture which have a large offset from the tileset origin that exceeds the
     * capacity of 32 bit integers. It is essentially an ad hoc RTC applied at read time only if the tile is far from the
     * origin and there is no RTC supplied either with the B3DM of the GLTF.
     * as the vertices are supplied in a quantized format, applying the RTC bias to
     * quantization origin will make these tiles work correctly.
     */
    let thisBias;
    if (undefined !== pseudoRtcBias)
      thisBias = (undefined === thisTransform) ? pseudoRtcBias : thisTransform.matrix.multiplyInverse(pseudoRtcBias);

    for (const meshKey of getGltfNodeMeshIds(node)) {
      const nodeMesh = this._meshes[meshKey];
      if (nodeMesh?.primitives) {
        const meshes = this.readMeshPrimitives(node, featureTable, thisTransform, thisBias);

        let renderGraphic: RenderGraphic | undefined;
        if (0 !== meshes.length) {
          if (1 === meshes.length) {
            renderGraphic = this.graphicFromMeshData(meshes[0], instances);
          } else {
            const thisList: RenderGraphic[] = [];
            for (const mesh of meshes) {
              renderGraphic = this.graphicFromMeshData(mesh, instances);
              if (undefined !== renderGraphic)
                thisList.push(renderGraphic);
            }

            if (0 !== thisList.length)
              renderGraphic = this._system.createGraphicList(thisList);
          }

          if (renderGraphic) {
            if (thisTransform && !thisTransform.isIdentity) {
              const branch = new GraphicBranch(true);
              branch.add(renderGraphic);
              renderGraphic = this._system.createBranch(branch, thisTransform);
            }

            renderGraphicList.push(renderGraphic);
          }
        }
      }
    }

    if (node.children) {
      for (const childId of node.children) {
        const child = this._nodes[childId];
        if (child)
          this.readNodeAndCreateGraphics(renderGraphicList, child, featureTable, transformStack, instances);
      }
    }

    transformStack.pop();
    return TileReadStatus.Success;
  }

  private readNodeAndCreatePolyfaces(polyfaces: Polyface[], node: GltfNode, transformStack: TransformStack, needNormals: boolean, needParams: boolean): void {
    // IMPORTANT: Do not return without popping this node from the stack.
    transformStack.push(node);
    const meshes = this.readMeshPrimitives(node);

    for (const mesh of meshes) {
      const polyface = this.polyfaceFromGltfMesh(mesh, transformStack.transform, needNormals, needParams);
      if (polyface)
        polyfaces.push(polyface);
    }

    if (node.children) {
      for (const childId of node.children) {
        const child = this._nodes[childId];
        if (child)
          this.readNodeAndCreatePolyfaces(polyfaces, child, transformStack, needNormals, needParams);
      }
    }
  }

  private polyfaceFromGltfMesh(mesh: GltfMeshData, transform: Transform | undefined , needNormals: boolean, needParams: boolean): Polyface | undefined {
    if (!mesh.pointQParams || !mesh.points || !mesh.indices)
      return undefined;

    const { points, pointQParams, normals, uvs, uvQParams, indices } = mesh;

    const includeNormals = needNormals && undefined !== normals;
    const includeParams = needParams && undefined !== uvQParams && undefined !== uvs;

    const polyface = IndexedPolyface.create(includeNormals, includeParams);
    for (let i = 0; i < points.length; ) {
      const point = pointQParams.unquantize(points[i++], points[i++], points[i++]);
      if (transform)
        transform.multiplyPoint3d(point, point);

      polyface.addPoint(point);
    }

    if (includeNormals && normals)
      for (let i = 0; i < normals.length; )
        polyface.addNormal(OctEncodedNormal.decodeValue(normals[i++]));

    if (includeParams && uvs && uvQParams)
      for (let i = 0; i < uvs.length; )
        polyface.addParam(uvQParams.unquantize(uvs[i++], uvs[i++]));

    let j = 0;
    for (const index of indices) {
      polyface.addPointIndex(index);
      if (includeNormals)
        polyface.addNormalIndex(index);

      if (includeParams)
        polyface.addParamIndex(index);

      if (0 === (++j % 3))
        polyface.terminateFacet();
    }

    return polyface;
  }

  // ###TODO what is the actual type of `json`?
  public getBufferView(json: { [k: string]: any }, accessorName: string): GltfBufferView | undefined {
    try {
      const accessorValue = JsonUtils.asString(json[accessorName]);
      const accessor = accessorValue ? this._accessors[accessorValue] : undefined;
      if (!accessor)
        return undefined;

      const bufferViewAccessorValue = accessor.bufferView;
      const bufferView = undefined !== bufferViewAccessorValue ? this._bufferViews[bufferViewAccessorValue] : undefined;
      if (!bufferView || undefined === bufferView.buffer)
        return undefined;

      const buffer = this._buffers[bufferView.buffer];
      const bufferData = buffer?.resolvedBuffer;
      if (!bufferData)
        return undefined;

      const type = accessor.componentType as GltfDataType;
      let dataSize = 0;
      switch (type) {
        case GltfDataType.UnsignedByte:
          dataSize = 1;
          break;
        case GltfDataType.UnsignedShort:
          dataSize = 2;
          break;
        case GltfDataType.UInt32:
        case GltfDataType.Float:
          dataSize = 4;
          break;
        default:
          return undefined;
      }
      let componentCount = 1;
      switch (accessor.type) {
        case "VEC3":
          componentCount = 3;
          break;
        case "VEC2":
          componentCount = 2;
          break;
      }

      const byteStride = bufferView.byteStride ? bufferView.byteStride : componentCount * dataSize;
      const offset = ((bufferView && bufferView.byteOffset) ? bufferView.byteOffset : 0) + (accessor.byteOffset ? accessor.byteOffset : 0);
      const length = byteStride * accessor.count;

      // If the data is misaligned (Scalable mesh tile publisher) use slice to copy -- else use subarray.
      const aligned = 0 === (bufferData.byteOffset + offset) % dataSize;
      const bytes = aligned ? bufferData.subarray(offset, offset + length) : bufferData.slice(offset, offset + length);
      return new GltfBufferView(bytes, accessor.count, type, accessor, byteStride / dataSize);
    } catch (e) {
      return undefined;
    }
  }

  public readBufferData32(json: { [k: string]: any }, accessorName: string): GltfBufferData | undefined { return this.readBufferData(json, accessorName, GltfDataType.UInt32); }
  public readBufferData16(json: { [k: string]: any }, accessorName: string): GltfBufferData | undefined { return this.readBufferData(json, accessorName, GltfDataType.UnsignedShort); }
  public readBufferData8(json: { [k: string]: any }, accessorName: string): GltfBufferData | undefined { return this.readBufferData(json, accessorName, GltfDataType.UnsignedByte); }
  public readBufferDataFloat(json: { [k: string]: any }, accessorName: string): GltfBufferData | undefined { return this.readBufferData(json, accessorName, GltfDataType.Float); }

  protected constructor(args: GltfReaderArgs) {
    this._glTF = args.props.glTF;
    this._version = args.props.version;
    this._yAxisUp = args.props.yAxisUp;
    this._baseUrl = args.props.baseUrl;

    const rtcCenter = args.props.glTF.extensions?.CESIUM_RTC?.center;
    if (rtcCenter && 3 === rtcCenter.length)
      if (0 !== rtcCenter[0] || 0 !== rtcCenter[1] || 0 !== rtcCenter[2])
        this._returnToCenter = Point3d.fromJSON(rtcCenter);

    this._iModel = args.iModel;
    this._is3d = true !== args.is2d;
    this._system = args.system ?? IModelApp.renderSystem;
    this._type = args.type ?? BatchType.Primary;
    this._canceled = args.shouldAbort;
    this._deduplicateVertices = args.deduplicateVertices ?? false;
    this._vertexTableRequired = args.vertexTableRequired ?? false;

    const binaryData = args.props.binaryData;
    if (binaryData) {
      const buffer = this._buffers[this._version === 2 ? 0 : "binary_glTF"];
      if (buffer && undefined === buffer.uri)
        buffer.resolvedBuffer = binaryData;
    }

    // The original implementation of GltfReader would process and produce graphics for every node in glTF.nodes.
    // What it's *supposed* to do is process the nodes in glTF.scenes[glTF.scene].nodes
    // Some nodes may not be referenced by the configured scene, or only indirectly via GltfNode.children.
    // Perhaps some faulty tiles existed that didn't define their scenes properly?
    let sceneNodes;
    if (this._glTF.scenes && undefined !== this._glTF.scene)
      sceneNodes = this._glTF.scenes[this._glTF.scene]?.nodes;

    if (!sceneNodes)
      sceneNodes = Object.keys(this._nodes);

    this._sceneNodes = sceneNodes;
  }

  protected readBufferData(json: { [k: string]: any }, accessorName: string, type: GltfDataType): GltfBufferData | undefined {
    const view = this.getBufferView(json, accessorName);
    return undefined !== view ? view.toBufferData(type) : undefined;
  }

  protected readFeatureIndices(_json: any): number[] | undefined { return undefined; }

  private extractId(value: any): string | undefined {
    switch (typeof value) {
      case "string":
        return value;
      case "number":
        return value.toString();
      default:
        return undefined;
    }
  }

  private extractTextureId(material: GltfMaterial): string | undefined {
    if (typeof material !== "object")
      return undefined;

    // Bimium's shader value...almost certainly obsolete at this point.
    if (isGltf1Material(material))
      return material.diffuse ?? this.extractId(material.values?.tex);

    // KHR_techniques_webgl extension
    const techniques = this._glTF.extensions?.KHR_techniques_webgl?.techniques;
    const ext = Array.isArray(techniques) ? material.extensions?.KHR_techniques_webgl : undefined;
    if (techniques && undefined !== ext && typeof(ext.values) === "object") {
      const uniforms = typeof ext.technique === "number" ? techniques[ext.technique].uniforms : undefined;
      if (typeof uniforms === "object") {
        for (const uniformName of Object.keys(uniforms)) {
          const uniform = uniforms[uniformName];
          if (typeof uniform === "object" && uniform.type === GltfDataType.Sampler2d)
            return this.extractId((ext.values[uniformName] as any)?.index);
        }
      }
    }

    const id = this.extractId(material.pbrMetallicRoughness?.baseColorTexture?.index);
    return id ?? this.extractId(material.emissiveTexture?.index);
  }

  private extractNormalMapId(material: GltfMaterial): string | undefined {
    if (typeof material !== "object")
      return undefined;

    if (isGltf1Material(material))
      return undefined;

    return this.extractId(material.normalTexture?.index);
  }

  private isMaterialTransparent(material: GltfMaterial): boolean {
    if (isGltf1Material(material)) {
      if (this._glTF.techniques && undefined !== material.technique) {
        const technique = this._glTF.techniques[material.technique];
        if (technique?.states?.enable?.some((state: GltfTechniqueState) => state === GltfTechniqueState.Blend))
          return true;
      }

      return false;
    } else {
      // Default: OPAQUE.
      // ###TODO support MASK. For now treat as opaque.
      return "BLEND" === material.alphaMode;
    }
  }

  protected createDisplayParams(material: GltfMaterial, hasBakedLighting: boolean): DisplayParams | undefined {
    const isTransparent = this.isMaterialTransparent(material);
    const textureId = this.extractTextureId(material);
    const normalMapId = this.extractNormalMapId(material);
    const textureMapping = (undefined !== textureId || undefined !== normalMapId) ? this.findTextureMapping(textureId, isTransparent, normalMapId) : undefined;
    const color = colorFromMaterial(material, isTransparent);
    let renderMaterial: RenderMaterial | undefined;
    if (undefined !== textureMapping && undefined !== textureMapping.normalMapParams) {
      const args: CreateRenderMaterialArgs = { diffuse: { color }, specular: { color: ColorDef.white }, textureMapping };
      renderMaterial = IModelApp.renderSystem.createRenderMaterial(args);
    }
    return new DisplayParams(DisplayParams.Type.Mesh, color, color, 1, LinePixels.Solid, FillFlags.Always, renderMaterial, undefined, hasBakedLighting, textureMapping);
  }

  private readMeshPrimitives(node: GltfNode, featureTable?: FeatureTable, thisTransform?: Transform, thisBias?: Vector3d): GltfMeshData[] {
    const meshes: GltfMeshData[] = [];
    for (const meshKey of getGltfNodeMeshIds(node)) {
      const nodeMesh = this._meshes[meshKey];
      if (nodeMesh?.primitives) {
        for (const primitive of nodeMesh.primitives) {
          const mesh = this.readMeshPrimitive(primitive, featureTable, thisBias);
          if (mesh) {
            meshes.push(mesh);
            if (this._computedContentRange && mesh.pointRange) {
              const invTransform = thisTransform?.inverse();
              const meshRange = invTransform ? invTransform.multiplyRange(mesh.pointRange) : mesh.pointRange;
              this._computedContentRange.extendRange(meshRange);
            }
          }
        }
      }
    }

    return meshes;
  }

  protected readMeshPrimitive(primitive: GltfMeshPrimitive, featureTable?: FeatureTable, pseudoRtcBias?: Vector3d): GltfMeshData | undefined {
    const materialName = JsonUtils.asString(primitive.material);
    const material = 0 < materialName.length ? this._materials[materialName] : { };
    if (!material)
      return undefined;

    const hasBakedLighting = undefined === primitive.attributes.NORMAL || undefined !== material.extensions?.KHR_materials_unlit;
    const displayParams = material ? this.createDisplayParams(material, hasBakedLighting) : undefined;
    if (!displayParams)
      return undefined;

    let primitiveType: number = -1;
    const meshMode = JsonUtils.asInt(primitive.mode, GltfMeshMode.Triangles);
    switch (meshMode) {
      case GltfMeshMode.Lines:
        primitiveType = Mesh.PrimitiveType.Polyline;
        break;

      case GltfMeshMode.Points:
        primitiveType = Mesh.PrimitiveType.Point;
        break;

      case GltfMeshMode.Triangles:
        primitiveType = Mesh.PrimitiveType.Mesh;
        break;

      default:
        assert(false);
        return undefined;
    }

    const isVolumeClassifier = this._isVolumeClassifier;
    const meshPrimitive = Mesh.create({
      displayParams,
      features: featureTable,
      type: primitiveType,
      range: Range3d.createNull(),
      is2d: !this._is3d,
      isPlanar: false,
      hasBakedLighting,
      isVolumeClassifier,
      quantizePositions: true,
    });

    const mesh = new GltfMeshData(meshPrimitive);

    // We don't have real colormap - just load material color.  This will be used if non-Bentley
    // tile or fit the color table is uniform. For a non-Bentley, non-Uniform, we'll set the
    // uv parameters to pick the colors out of the color map texture.
    meshPrimitive.colorMap.insert(displayParams.fillColor.tbgr);   // White...

    const colorIndices = this.readBufferData16(primitive.attributes, "_COLORINDEX");
    if (undefined !== colorIndices && material) {
      let texStep;
      if (isGltf1Material(material))
        texStep = material.values?.texStep;
      else
        texStep = material.extensions?.KHR_techniques_webgl?.values?.u_texStep;

      if (texStep) {
        const uvParams = [];
        for (let i = 0; i < colorIndices.count; i++)
          uvParams.push(new Point2d(texStep[1] + texStep[0] * colorIndices.buffer[i], .5));

        const paramList = QPoint2dList.fromPoints(uvParams);
        mesh.uvs = paramList.toTypedArray();
        mesh.uvQParams = paramList.params;
      }
    }

    const draco = primitive.extensions?.KHR_draco_mesh_compression;
    if (draco)
      return this.readDracoMeshPrimitive(mesh.primitive, draco) ? mesh : undefined;

    this.readBatchTable(mesh.primitive, primitive);

    if (!this.readVertices(mesh, primitive, pseudoRtcBias))
      return undefined;

    switch (primitiveType) {
      case Mesh.PrimitiveType.Mesh: {
        if (!this.readMeshIndices(mesh, primitive))
          return undefined;

        if (!displayParams.ignoreLighting && !this.readNormals(mesh, primitive.attributes, "NORMAL"))
          return undefined;

        if (!mesh.uvs) {
          let texCoordIndex = 0;
          if (!isGltf1Material(material) && undefined !== material.pbrMetallicRoughness?.baseColorTexture?.texCoord)
            texCoordIndex = JsonUtils.asInt(material.pbrMetallicRoughness.baseColorTexture.texCoord);

          this.readUVParams(mesh, primitive.attributes, `TEXCOORD_${texCoordIndex}`);
        }

        if (this._deduplicateVertices && !this.deduplicateVertices(mesh))
          return undefined;

        break;
      }

      case Mesh.PrimitiveType.Polyline:
      case Mesh.PrimitiveType.Point: {
        if (undefined !== mesh.primitive.polylines && !this.readPolylines(mesh.primitive.polylines, primitive, "indices", Mesh.PrimitiveType.Point === primitiveType))
          return undefined;
        break;
      }
      default: {
        assert(false, "unhandled primitive type");
        return undefined;
      }
    }

    if (displayParams.textureMapping && !mesh.uvs)
      return undefined;

    if (primitive.extensions?.CESIUM_primitive_outline) {
      const data = this.readBufferData32(primitive.extensions.CESIUM_primitive_outline, "indices");
      if (data !== undefined) {
        assert(0 === data.count % 2);
        mesh.primitive.edges = new MeshEdges();
        for (let i = 0; i < data.count;)
          mesh.primitive.edges.visible.push(new MeshEdge(data.buffer[i++], data.buffer[i++]));
      }
    }

    return mesh;
  }

  private readDracoMeshPrimitive(mesh: Mesh, ext: DracoMeshCompression): boolean {
    const draco = this._dracoMeshes.get(ext);
    if (!draco || "triangle-list" !== draco.topology)
      return false;

    const indices = draco.indices?.value;
    if (!indices || (indices.length % 3) !== 0)
      return false;

    const pos = draco.attributes.POSITION?.value;
    if (!pos || (pos.length % 3) !== 0)
      return false;

    // ###TODO: I have yet to see a draco-encoded mesh with interleaved attributes. Currently not checking.
    const triangle = new Triangle();
    for (let i = 0; i < indices.length; i += 3) {
      triangle.setIndices(indices[i], indices[i + 1], indices[i + 2]);
      mesh.addTriangle(triangle);
    }

    let posRange: Range3d;
    const bbox = draco.header?.boundingBox;
    if (bbox) {
      posRange = Range3d.createXYZXYZ(bbox[0][0], bbox[0][1], bbox[0][2], bbox[1][0], bbox[1][1], bbox[1][2]);
    } else {
      posRange = Range3d.createNull();
      for (let i = 0; i < pos.length; i += 3)
        posRange.extendXYZ(pos[i], pos[i + 1], pos[i + 2]);
    }

    assert(mesh.points instanceof QPoint3dList);
    mesh.points.params.setFromRange(posRange);
    const pt = Point3d.createZero();
    for (let i = 0; i < pos.length; i += 3) {
      pt.set(pos[i], pos[i + 1], pos[i + 2]);
      mesh.points.add(pt);
    }

    const normals = draco.attributes.NORMAL?.value;
    if (normals && (normals.length % 3) === 0) {
      const vec = Vector3d.createZero();
      for (let i = 0; i < normals.length; i += 3) {
        vec.set(normals[i], normals[i + 1], normals[i + 2]);
        mesh.normals.push(OctEncodedNormal.fromVector(vec));
      }
    }

    const uvs = draco.attributes.TEXCOORD_0?.value;
    if (uvs && (uvs.length & 2) === 0)
      for (let i = 0; i < uvs.length; i += 2)
        mesh.uvParams.push(new Point2d(uvs[i], uvs[i + 1]));

    const batchIds = draco.attributes._BATCHID?.value;
    if (batchIds && mesh.features) {
      const featureIndices = [];
      for (const batchId of batchIds)
        featureIndices.push(batchId);

      mesh.features.setIndices(featureIndices);
    }

    return true;
  }

  private deduplicateVertices(mesh: GltfMeshData): boolean {
    if (!mesh.points || !mesh.indices)
      return false;

    const numPoints = mesh.indices.length;
    assert(0 === numPoints % 3);

    const indices = mesh.indices;
    if (indices instanceof Uint16Array && numPoints > 0xffff)
      mesh.indices = new Uint32Array(numPoints);
    else if (indices instanceof Uint8Array && numPoints > 0xff)
      mesh.indices = new Uint32Array(numPoints);

    const points = new Uint16Array(3 * numPoints);
    const normals = mesh.normals ? new Uint16Array(numPoints) : undefined;
    const uvs = mesh.uvs ? new Uint16Array(2 * numPoints) : undefined;

    for (let i = 0; i < numPoints; i++) {
      const index = indices[i];
      mesh.indices[i] = i;

      points[i * 3 + 0] = mesh.points[index * 3 + 0];
      points[i * 3 + 1] = mesh.points[index * 3 + 1];
      points[i * 3 + 2] = mesh.points[index * 3 + 2];

      if (normals)
        normals[i] = mesh.normals![index];

      if (uvs) {
        uvs[i * 2 + 0] = mesh.uvs![index * 2 + 0];
        uvs[i * 2 + 1] = mesh.uvs![index * 2 + 1];
      }
    }

    mesh.points = points;
    mesh.normals = normals;
    mesh.uvs = uvs;

    return true;
  }

  /**
   *
   * @param positions quantized points
   * @param primitive input json
   * @param pseudoRtcBias a bias applied to each point - this is a workaround for tiles generated by
   * context capture which have a large offset from the tileset origin that exceeds the
   * capacity of 32 bit integers. This is essentially an ad hoc RTC applied at read time.
   */
  private readVertices(mesh: GltfMeshData, primitive: GltfMeshPrimitive, pseudoRtcBias?: Vector3d): boolean {
    const view = this.getBufferView(primitive.attributes, "POSITION");
    if (undefined === view)
      return false;

    if (GltfDataType.Float === view.type) {
      const buffer = view.toBufferData(GltfDataType.Float);
      if (undefined === buffer)
        return false;

      const strideSkip = view.stride - 3;
      mesh.pointRange = Range3d.createNull();
      for (let i = 0; i < buffer.buffer.length; i += strideSkip)
        mesh.pointRange.extendXYZ(buffer.buffer[i++], buffer.buffer[i++], buffer.buffer[i++]);

      const positions = new QPoint3dList(QParams3d.fromRange(mesh.pointRange));
      const scratchPoint = new Point3d();
      for (let i = 0, j = 0; i < buffer.count; i++, j += strideSkip) {
        scratchPoint.set(buffer.buffer[j++], buffer.buffer[j++], buffer.buffer[j++]);
        if (undefined !== pseudoRtcBias)
          scratchPoint.subtractInPlace(pseudoRtcBias);

        positions.add(scratchPoint);
      }
      mesh.pointQParams = positions.params;
      mesh.points = positions.toTypedArray();
    } else {
      if (GltfDataType.UnsignedShort !== view.type)
        return false;

      const quantized = view.accessor.extensions?.WEB3D_quantized_attributes;
      const rangeMin = quantized?.decodedMin;
      const rangeMax = quantized?.decodedMax;
      if (!rangeMin || !rangeMax) // required by spec...
        return false;

      // ###TODO apply WEB3D_quantized_attributes.decodeMatrix? Have not encountered in the wild; glTF 1.0 only.
      const buffer = view.toBufferData(GltfDataType.UnsignedShort);
      if (undefined === buffer || !(buffer.buffer instanceof Uint16Array))
        return false;

      assert(buffer.buffer instanceof Uint16Array);
      mesh.pointRange = Range3d.createXYZXYZ(rangeMin[0], rangeMin[1], rangeMin[2], rangeMax[0], rangeMax[1], rangeMax[2]);
      if (undefined !== pseudoRtcBias) {
        mesh.pointRange.low.subtractInPlace(pseudoRtcBias);
        mesh.pointRange.high.subtractInPlace(pseudoRtcBias);
      }
      mesh.pointQParams = QParams3d.fromRange(mesh.pointRange);
      if (3 === view.stride) {
        mesh.points = buffer.buffer;
      } else {
        mesh.points = new Uint16Array(3 * view.count);
        for (let i = 0, j = 0; i < view.count; i++) {
          const index = i * view.stride;
          mesh.points[j++] = buffer.buffer[index];
          mesh.points[j++] = buffer.buffer[index + 1];
          mesh.points[j++] = buffer.buffer[index + 2];
        }
      }
    }

    return true;
  }

  protected readIndices(json: { [k: string]: any }, accessorName: string): number[] | undefined {
    const data = this.readBufferData32(json, accessorName);
    if (undefined === data)
      return undefined;

    const indices = [];
    for (let i = 0; i < data.count; i++)
      indices.push(data.buffer[i]);

    return indices;
  }

  protected readBatchTable(_mesh: Mesh, _json: any) {
  }

  protected readMeshIndices(mesh: GltfMeshData, json: { [k: string]: any }): boolean {
    if (undefined !== json.indices) {
      const data = this.readBufferData16(json, "indices") || this.readBufferData32(json, "indices");
      if (data && (data.buffer instanceof Uint8Array || data.buffer instanceof Uint16Array || data.buffer instanceof Uint32Array)) {
        mesh.indices = data.buffer;
        return true;
      }

      return false;
    }

    // Non-indexed geometry. Manufacture triangle indices from points.
    const numPoints = mesh.points?.length;
    if (undefined === numPoints || 0 !== numPoints % 3)
      return false;

    mesh.indices = numPoints < 255 ? new Uint8Array(numPoints) : (numPoints < 0xffff ? new Uint16Array(numPoints) : new Uint32Array(numPoints));
    for (let i = 0; i < numPoints; i++)
      mesh.indices[i] = i;

    return true;
  }

  protected readNormals(mesh: GltfMeshData, json: { [k: string]: any }, accessorName: string): boolean {
    const view = this.getBufferView(json, accessorName);
    if (undefined === view)
      return false;

    switch (view.type) {
      case GltfDataType.Float: {
        const data = view.toBufferData(GltfDataType.Float);
        if (undefined === data)
          return false;

        mesh.normals = new Uint16Array(data.count);
        const scratchNormal = new Vector3d();
        const strideSkip = view.stride - 3;
        for (let i = 0, j = 0; i < data.count; i++, j += strideSkip) {
          scratchNormal.set(data.buffer[j++], data.buffer[j++], data.buffer[j++]);
          mesh.normals[i] = OctEncodedNormal.encode(scratchNormal);
        }
        return true;
      }

      case GltfDataType.UnsignedByte: {
        const data = view.toBufferData(GltfDataType.UnsignedByte);
        if (undefined === data)
          return false;

        // ###TODO: we shouldn't have to allocate OctEncodedNormal objects...just use uint16s / numbers...
        mesh.normals = new Uint16Array(data.count);
        for (let i = 0; i < data.count; i++) {
          // ###TODO? not clear why ray writes these as pairs of uint8...
          const index = i * view.stride;
          const normal = data.buffer[index] | (data.buffer[index + 1] << 8);
          mesh.normals[i] = normal;
        }
        return true;
      }
      default:
        return false;
    }
  }

  private readUVParams(mesh: GltfMeshData, json: { [k: string]: any }, accessorName: string): boolean {
    const view = this.getBufferView(json, accessorName);

    if (view === undefined)
      return false;

    switch (view.type) {
      case GltfDataType.Float: {
        const data = this.readBufferDataFloat(json, accessorName);
        if (!data)
          return false;

        mesh.uvRange = Range2d.createNull();

        for (let i = 0; i < data.count; i++) {
          const index = view.stride * i; // 2 float per param...
          mesh.uvRange.extendXY(data.buffer[index], data.buffer[index + 1]);
        }
        mesh.uvQParams = QParams2d.fromRange(mesh.uvRange);
        mesh.uvs = new Uint16Array(data.count * 2);
        for (let i = 0, j = 0; i < data.count; i++) {
          const index = view.stride * i; // 2 float per param...
          mesh.uvs[j++] = Quantization.quantize(data.buffer[index], mesh.uvQParams.origin.x, mesh.uvQParams.scale.x);
          mesh.uvs[j++] = Quantization.quantize(data.buffer[index + 1], mesh.uvQParams.origin.y, mesh.uvQParams.scale.y);
        }
        return true;
      }

      case GltfDataType.UnsignedShort: {
        const quantized = view.accessor.extensions?.WEB3D_quantized_attributes;
        const rangeMin = quantized?.decodedMin;
        const rangeMax = quantized?.decodedMax;
        if (undefined === rangeMin || undefined === rangeMax)
          return false;

        const qData = view.toBufferData(GltfDataType.UnsignedShort);
        if (undefined === qData || !(qData.buffer instanceof Uint16Array))
          return false;

        mesh.uvRange = Range2d.createXYXY(rangeMin[0], rangeMin[1], rangeMax[0], rangeMax[1]);
        mesh.uvQParams = QParams2d.fromRange(mesh.uvRange);
        if (2 === view.stride) {
          mesh.uvs = qData.buffer;
        } else {
          mesh.uvs = new Uint16Array(2 * view.count);
          for (let i = 0, j = 0; i < view.count; i++) {
            const index = i * view.stride;
            mesh.uvs[j++] = qData.buffer[index];
            mesh.uvs[j++] = qData.buffer[index + 1];
          }
        }
        return true;
      }
      default:
        assert(false);
        return false;

    }

    return true;
  }

  protected readPolylines(polylines: MeshPolylineList, json: { [k: string]: any }, accessorName: string, disjoint: boolean): boolean {
    const data = this.readBufferData32(json, accessorName);
    if (undefined === data)
      return false;

    const indices = new Array<number>();
    if (disjoint) {
      for (let i = 0; i < data.count;)
        indices.push(data.buffer[i++]);
    } else {
      for (let i = 0; i < data.count;) {
        const index0 = data.buffer[i++];
        const index1 = data.buffer[i++];
        if (0 === indices.length || index0 !== indices[indices.length - 1]) {
          if (indices.length !== 0) {
            polylines.push(new MeshPolyline(indices));
            indices.length = 0;
          }
          indices.push(index0);
        }
        indices.push(index1);
      }
    }
    if (indices.length !== 0)
      polylines.push(new MeshPolyline(indices));

    return true;
  }

  protected async resolveResources(): Promise<void> {
    // Load any external images and buffers.
    await this._resolveResources();

    // If any meshes are draco-compressed, dynamically load the decoder module and then decode the meshes.
    const dracoMeshes: DracoMeshCompression[] = [];

    for (const node of this.traverseScene()) {
      for (const meshId of getGltfNodeMeshIds(node)) {
        const mesh = this._meshes[meshId];
        if (mesh?.primitives)
          for (const primitive of mesh.primitives)
            if (primitive.extensions?.KHR_draco_mesh_compression)
              dracoMeshes.push(primitive.extensions.KHR_draco_mesh_compression);
      }
    }

    if (dracoMeshes.length === 0)
      return;

    try {
      const dracoLoader = (await import("@loaders.gl/draco")).DracoLoader;
      await Promise.all(dracoMeshes.map(async (x) => this.decodeDracoMesh(x, dracoLoader)));
    } catch (err) {
      Logger.logWarning(FrontendLoggerCategory.Render, "Failed to decode draco-encoded glTF mesh");
      Logger.logException(FrontendLoggerCategory.Render, err);
    }
  }

  private async _resolveResources(): Promise<void> {
    // ###TODO traverse the scene nodes to find resources referenced by them, instead of resolving everything - some resources may not
    // be required for the scene.
    const promises: Array<Promise<void>> = [];
    try {
      for (const buffer of gltfDictionaryIterator(this._buffers))
        if (!buffer.resolvedBuffer)
          promises.push(this.resolveBuffer(buffer));

      await Promise.all(promises);
      if (this._isCanceled)
        return;

      promises.length = 0;
      for (const image of gltfDictionaryIterator(this._images))
        if (!image.resolvedImage)
          promises.push(this.resolveImage(image));

      await Promise.all(promises);
    } catch (_) {
    }
  }

  private async decodeDracoMesh(ext: DracoMeshCompression, loader: typeof DracoLoader): Promise<void> {
    const bv = this._bufferViews[ext.bufferView];
    if (!bv || !bv.byteLength)
      return;

    let buf = this._buffers[bv.buffer]?.resolvedBuffer;
    if (!buf)
      return;

    const offset = bv.byteOffset ?? 0;
    buf = buf.subarray(offset, offset + bv.byteLength);
    const mesh = await loader.parse(buf, { }); // NB: `options` argument declared optional but will produce exception if not supplied.
    if (mesh)
      this._dracoMeshes.set(ext, mesh);
  }

  private resolveUrl(uri: string): string | undefined {
    try {
      return new URL(uri, this._baseUrl).toString();
    } catch (_) {
      return undefined;
    }
  }

  private async resolveBuffer(buffer: GltfBuffer & { resolvedBuffer?: Uint8Array }): Promise<void> {
    if (buffer.resolvedBuffer || undefined === buffer.uri)
      return;

    try {
      const url = this.resolveUrl(buffer.uri);
      const response = url ? await fetch(url) : undefined;
      if (this._isCanceled)
        return;

      const data = await response?.arrayBuffer();
      if (this._isCanceled)
        return;

      if (data)
        buffer.resolvedBuffer = new Uint8Array(data);
    } catch (_) {
      //
    }
  }

  private async resolveImage(image: GltfImage & { resolvedImage?: TextureImageSource }): Promise<void> {
    if (image.resolvedImage)
      return;

    interface BufferViewSource { bufferView?: GltfId, mimeType?: string }
    const bvSrc: BufferViewSource | undefined = undefined !== image.bufferView ? image : image.extensions?.KHR_binary_glTF;
    if (undefined !== bvSrc?.bufferView) {
      const format = undefined !== bvSrc.mimeType ? getImageSourceFormatForMimeType(bvSrc.mimeType) : undefined;
      const bufferView = this._bufferViews[bvSrc.bufferView];
      if (undefined === format || !bufferView || !bufferView.byteLength || bufferView.byteLength < 0)
        return;

      const bufferData = this._buffers[bufferView.buffer]?.resolvedBuffer;
      if (!bufferData)
        return;

      const offset = bufferView.byteOffset ?? 0;
      const bytes = bufferData.subarray(offset, offset + bufferView.byteLength);
      try {
        const imageSource = new ImageSource(bytes, format);
        if (this._system.supportsCreateImageBitmap)
          image.resolvedImage = await imageBitmapFromImageSource(imageSource);
        else
          image.resolvedImage = await imageElementFromImageSource(imageSource);
      } catch (_) {
        //
      }

      return;
    }

    const url = undefined !== image.uri ? this.resolveUrl(image.uri) : undefined;
    if (undefined !== url)
      image.resolvedImage = await tryImageElementFromUrl(url);
  }

  /** The glTF spec says that if GltfSampler.wrapS/T are omitted, they default to Repeat.
   * However, the reality data service serves tiles that lack any wrapS/T property, and we want those clamped to edge, not repeated.
   * (We also don't want to produce mip-maps for them, which is determined indirectly from the wrap mode).
   * Allow the default to be optionally overridden.
   */
  public defaultWrapMode = GltfWrapMode.Repeat;

  /** Exposed strictly for testing. */
  public getTextureType(sampler?: GltfSampler): RenderTexture.Type {
    // ###TODO: RenderTexture currently does not support different wrapping behavior for U vs V, nor does it support mirrored repeat.
    let wrapS = sampler?.wrapS;
    let wrapT = sampler?.wrapT;
    if (undefined === wrapS && undefined === wrapT)
      wrapS = wrapT = this.defaultWrapMode;

    if (GltfWrapMode.ClampToEdge === wrapS || GltfWrapMode.ClampToEdge === wrapT)
      return RenderTexture.Type.TileSection;

    return RenderTexture.Type.Normal;
  }

  private resolveTexture(textureId: string, isTransparent: boolean): RenderTexture | false {
    const texture = this._textures[textureId];
    if (!texture || undefined === texture.source)
      return false;

    const image = this._images[texture.source]?.resolvedImage;
    if (!image)
      return false;

    const samplerId = texture.sampler;
    const sampler = undefined !== samplerId ? this._samplers[samplerId] : undefined;
    const textureType = this.getTextureType(sampler);
    const renderTexture = this._system.createTexture({
      type: textureType,
      image: {
        source: image,
        transparency: isTransparent ? TextureTransparency.Mixed : TextureTransparency.Opaque,
      },
    });

    return renderTexture ?? false;
  }

  protected findTextureMapping(id: string | undefined, isTransparent: boolean, normalMapId: string | undefined): TextureMapping | undefined {
    if (undefined === id && undefined === normalMapId)
      return undefined;

    let texture;
    if (undefined !== id) {
      texture = this._resolvedTextures.get({ id, isTransparent });
      if (undefined === texture)
        this._resolvedTextures.set({ id, isTransparent }, texture = this.resolveTexture(id, isTransparent));
    }

    let normalMap;
    if (undefined !== normalMapId) {
      normalMap = this._resolvedTextures.get({ id: normalMapId, isTransparent: false });
      if (undefined === normalMap)
        this._resolvedTextures.set({ id: normalMapId, isTransparent: false }, normalMap = this.resolveTexture(normalMapId, false));
    }

    let nMap;
    if (normalMap) {
      const greenUp = true;
      if (texture) {
        nMap = {
          normalMap,
          greenUp,
        };
      } else {
        texture = normalMap;
        nMap = { greenUp };
      }
    }

    if (!texture)
      return undefined;

    const textureMapping = new TextureMapping(texture, new TextureMapping.Params());
    textureMapping.normalMapParams = nMap;
    return textureMapping;
  }
}

/** Arguments supplied to [[readGltfGraphics]] to produce a [[RenderGraphic]] from a [glTF](https://www.khronos.org/gltf/) asset.
 * @public
 */
export interface ReadGltfGraphicsArgs {
  /** A representation of the glTF data as one of:
   *  - The binary data in glb format as a Uint8Array; or
   *  - A JSON object conforming to the [glTF 2.0 specification](https://www.khronos.org/registry/glTF/specs/2.0/glTF-2.0.html); or
   *  - A Uint8Array containing the utf8-encoded stringified JSON of an object conforming to the [glTF 2.0 specification](https://www.khronos.org/registry/glTF/specs/2.0/glTF-2.0.html).
   */
  gltf: Uint8Array | Object;
  /** The iModel with which the graphics will be associated - typically obtained from the [[Viewport]] into which they will be drawn. */
  iModel: IModelConnection;
  /** Options for making the graphic [pickable]($docs/learning/frontend/ViewDecorations#pickable-view-graphic-decorations).
   * Only the [[PickableGraphicOptions.id]] property is required to make the graphics pickable. If a `modelId` is also supplied and differs from the `id`,
   * the graphics will also be selectable.
   */
  pickableOptions?: PickableGraphicOptions;
  /** The base URL for any relative URIs in the glTF. Typically, this is the same as the URL for the glTF asset itself.
   * If not supplied, relative URIs cannot be resolved. For glTF assets containing no relative URIs, this is not required.
   */
  baseUrl?: string;
  /** @alpha */
  contentRange?: ElementAlignedBox3d;
  /** @alpha */
  transform?: Transform;
  /** @alpha */
  hasChildren?: boolean;
}

/** Produce a [[RenderGraphic]] from a [glTF](https://www.khronos.org/gltf/) asset suitable for use in [view decorations]($docs/learning/frontend/ViewDecorations).
 * @returns a graphic produced from the glTF asset's default scene, or `undefined` if a graphic could not be produced from the asset.
 * @note Support for the full [glTF 2.0 specification](https://www.khronos.org/registry/glTF/specs/2.0/glTF-2.0.html) is currently a work in progress.
 * If a particular glTF asset fails to load and/or display properly, please
 * [submit an issue](https://github.com/iTwin/itwinjs-core/issues).
 * @see [Example decorator]($docs/learning/frontend/ViewDecorations#gltf-decorations) for an example of a decorator that reads and displays a glTF asset.
 * @public
 */
export async function readGltfGraphics(args: ReadGltfGraphicsArgs): Promise<RenderGraphic | undefined> {
  const props = GltfReaderProps.create(args.gltf, true, args.baseUrl); // glTF supports exactly one coordinate system with y axis up.
  const reader = props ? new GltfGraphicsReader(props, args) : undefined;
  if (!reader)
    return undefined;

  const result = await reader.read();
  return result.graphic;
}

/** Implements [[readGltfGraphics]]. Exported strictly for tests.
 * @internal
 */
export class GltfGraphicsReader extends GltfReader {
  private readonly _featureTable?: FeatureTable;
  private readonly _contentRange?: ElementAlignedBox3d;
  private readonly _transform?: Transform;
  private readonly _isLeaf: boolean;
  public readonly binaryData?: Uint8Array; // strictly for tests

  public constructor(props: GltfReaderProps, args: ReadGltfGraphicsArgs) {
    super({
      props,
      iModel: args.iModel,
      vertexTableRequired: true,
    });

    this._contentRange = args.contentRange;
    this._transform = args.transform;
    this._isLeaf = true !== args.hasChildren;

    this.binaryData = props.binaryData;
    const pickableId = args.pickableOptions?.id;
    if (pickableId) {
      this._featureTable = new FeatureTable(1, args.pickableOptions?.modelId ?? pickableId, BatchType.Primary);
      this._featureTable.insert(new Feature(pickableId));
    }
  }

  public async read(): Promise<GltfReaderResult> {
    await this.resolveResources();
    return this.readGltfAndCreateGraphics(this._isLeaf, this._featureTable, this._contentRange, this._transform);
  }

  public get nodes(): GltfDictionary<GltfNode> { return this._nodes; }
  public get scenes(): GltfDictionary<GltfScene> { return this._glTF.scenes ?? emptyDict; }
  public get sceneNodes(): GltfId[] { return this._sceneNodes; }
  public get textures(): GltfDictionary<GltfTexture> { return this._textures; }
}
