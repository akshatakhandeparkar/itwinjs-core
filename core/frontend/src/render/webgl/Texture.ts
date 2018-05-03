/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/

import { assert, IDisposable } from "@bentley/bentleyjs-core";
// import { Texture, TextureCreateParams } from "@bentley/imodeljs-common";
import { GL } from "./GL";
import { System, Capabilities } from "./System";

/** A private enum used to track certain desired texture creation parameters. */
const enum TextureFlags {
  None = 0,
  UseMipMaps = 1 << 0,
  Interpolate = 1 << 1,
  PreserveData = 1 << 2,
}

/** A private utility class used by TextureHandle to internally create textures with differing proprties. */
class TextureCreateParams {
  public rawData?: Uint8Array = undefined;
  public resizedCanvas?: HTMLCanvasElement = undefined;
  public width: number = 0;
  public height: number = 0;
  public format: GL.Texture.Format = GL.Texture.Format.Rgb;
  public dataType: GL.Texture.DataType = GL.Texture.DataType.UnsignedByte;
  public wrapMode: GL.Texture.WrapMode = GL.Texture.WrapMode.ClampToEdge;
  private _flags = TextureFlags.None;

  public get hasTranslucency() { return GL.Texture.Format.Rgba === this.format; }
  public get wantPreserveData() { return TextureFlags.None !== (this._flags & TextureFlags.PreserveData); }
  public set wantPreserveData(want: boolean) { this.setFlag(TextureFlags.PreserveData, want); }
  public get wantInterpolate() { return TextureFlags.None !== (this._flags & TextureFlags.Interpolate); }
  public set wantInterpolate(want: boolean) { this.setFlag(TextureFlags.Interpolate, want); }
  public get wantUseMipMaps() { return TextureFlags.None !== (this._flags & TextureFlags.UseMipMaps); }
  public set wantUseMipMaps(want: boolean) { this.setFlag(TextureFlags.UseMipMaps, want); }

  private setFlag(flag: TextureFlags, enable: boolean) {
    if (enable)
      this._flags |= flag;
    else
      this._flags &= ~flag;
  }
}

/** Encapsulates a handle to a WebGLTexture object created based on desired parameters. */
export class TextureHandle implements IDisposable {
  public readonly width: number;
  public readonly height: number;
  public readonly format: GL.Texture.Format;
  public readonly dataType: GL.Texture.DataType;
  public readonly data?: Uint8Array = undefined;
  public readonly resizedCanvas?: HTMLCanvasElement = undefined;

  private _glTexture?: WebGLTexture;

  /** Retrieves actual WebGLTexture object associated with this texture. */
  public getHandle(): WebGLTexture | undefined { return this._glTexture; }

  /** Binds texture handle (if available) associated with an instantiation of this class to specified texture unit. */
  public bind(texUnit: GL.Texture.Unit): boolean {
    if (undefined === this._glTexture)
      return false;
    TextureHandle.bindTexture(texUnit, this._glTexture);
    return true;
  }

  /** Binds specified texture handle to specified texture unit. */
  public static bindTexture(texUnit: GL.Texture.Unit, glTex: WebGLTexture | undefined) {
    const gl: WebGLRenderingContext = System.instance.context;
    gl.activeTexture(texUnit);
    gl.bindTexture(gl.TEXTURE_2D, glTex !== undefined ? glTex : null); // ###TODO: might need to set the shader sampler handler here
  }

  /** Creates a texture for an image based on certain parameters. */
  public static createForImage(width: number, imageBytes: Uint8Array, isTranslucent: boolean, useMipMaps = true, isGlyph = false, isTileSection = false, wantPreserveData = false) {
    const glTex: WebGLTexture | undefined = this.createTextureHandle();
    if (undefined === glTex) {
      return undefined;
    }

    const caps: Capabilities = System.instance.capabilities;

    const params: TextureCreateParams = new TextureCreateParams();
    params.format = isTranslucent ? GL.Texture.Format.Rgba : GL.Texture.Format.Rgb;
    params.width = width;
    params.height = imageBytes.length / (width * (isTranslucent ? 4 : 3));
    params.rawData = imageBytes;
    params.wrapMode = isTileSection ? GL.Texture.WrapMode.ClampToEdge : GL.Texture.WrapMode.Repeat;
    params.wantUseMipMaps = useMipMaps;
    params.wantPreserveData = wantPreserveData;

    let targetWidth: number = params.width;
    let targetHeight: number = params.height;

    if (isGlyph) {
      params.wrapMode = GL.Texture.WrapMode.ClampToEdge;
      params.wantUseMipMaps = true; // in order to always use mipmaps, must resize to power of 2
      targetWidth = TextureHandle.nextHighestPowerOfTwo(targetWidth);
      targetHeight = TextureHandle.nextHighestPowerOfTwo(targetHeight);
    } else if (!caps.supportsNonPowerOf2Textures && (!TextureHandle.isPowerOfTwo(targetWidth) || !TextureHandle.isPowerOfTwo(targetHeight))) {
      if (GL.Texture.WrapMode.ClampToEdge === params.wrapMode) {
        // NPOT are supported but not mipmaps
        // Probably on poor hardware so I choose to disable mimpaps for lower memory usage over quality. If quality is required we need to resize the image to a pow of 2.
        // Above comment is not necessarily true - WebGL doesn't support NPOT mipmapping, only supporting base NPOT caps
        params.wantUseMipMaps = false;
      } else if (GL.Texture.WrapMode.Repeat === params.wrapMode) {
        targetWidth = TextureHandle.nextHighestPowerOfTwo(targetWidth);
        targetHeight = TextureHandle.nextHighestPowerOfTwo(targetHeight);
      }
    }

    if (isTileSection) {
      // Largely for sheet tiles.  In some extreme cases, mipmapping lowers quality significantly due to a stretched view
      // and fuzziness introduced by combining the layers.  A straight GL_LINEAR blend gives a better picture.
      params.wantUseMipMaps = false;
      params.wantInterpolate = true;
    }

    if (targetWidth !== params.width || targetWidth !== params.height) {
      const rCanvas = TextureHandle.resizeImageBytesToCanvas(imageBytes, isTranslucent, params.width, params.height, targetWidth, targetHeight);
      if (undefined === rCanvas)
        return undefined;
      params.resizedCanvas = rCanvas;
    }

    assert(0 < params.height);
    assert(Math.floor(params.height) === params.height);

    return new TextureHandle(glTex, params);
  }

  /** Creates a texture for a framebuffer attachment (no data specified). */
  public static createForAttachment(width: number, height: number, format: GL.Texture.Format, dataType: GL.Texture.DataType /* , isTranslucent: boolean */ ) {
    // ###TODO: rename createForAttachment
    const glTex: WebGLTexture | undefined = this.createTextureHandle();
    if (undefined === glTex) {
      return undefined;
    }

    const params: TextureCreateParams = new TextureCreateParams();
    params.format = format;
    params.dataType = dataType;
    params.width = width;
    params.height = height;
    params.wrapMode = GL.Texture.WrapMode.ClampToEdge;
    params.wantInterpolate = true;
    // ###TODO: isTranslucent flag - shouldn't this just be determined based on format?

    return new TextureHandle(glTex, params);
  }

  // ###TODO: lookup table textures: createForVertexLookup, createForAnimationLookup

  public dispose() {
    if (undefined !== this._glTexture) {
      System.instance.context.deleteTexture(this._glTexture);
      this._glTexture = undefined;
    }
  }

  private constructor(glTex: WebGLTexture, params: TextureCreateParams) {
      const gl: WebGLRenderingContext = System.instance.context;

      this.width = params.width;
      this.height = params.height;
      this.format = params.format;
      this.dataType = params.dataType;
      if (params.wantPreserveData) {
        this.data = params.rawData;
        this.resizedCanvas = params.resizedCanvas;
      }

      this._glTexture = glTex;

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // use tightly packed data

      gl.activeTexture(gl.TEXTURE0); // bind the texture object; make sure we do not interfere with other active textures
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      assert(this.width > 0 && this.height > 0);

      // send the texture data
      if (params.resizedCanvas !== undefined) {
        // use HTMLCanvasElement version of texImage2D
        gl.texImage2D(gl.TEXTURE_2D, 0, params.format, params.format, params.dataType, params.resizedCanvas);
      } else {
        // use regular (raw bytes) version of texImage2D
        const pixels: ArrayBufferView | null = params.rawData !== undefined ? params.rawData as ArrayBufferView : null;
        gl.texImage2D(gl.TEXTURE_2D, 0, params.format, params.width, params.height, 0, params.format, params.dataType, pixels);
      }

      if (params.wantUseMipMaps) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, params.wantInterpolate ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, params.wantInterpolate ? gl.LINEAR : gl.NEAREST);
      }

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, params.wrapMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, params.wrapMode);

      gl.bindTexture(gl.TEXTURE_2D, null);
    }

  private static createTextureHandle(): WebGLTexture | undefined {
    const glTex: WebGLTexture | null = System.instance.context.createTexture();
    if (glTex === null)
      return undefined;
    return glTex;
  }

  private static nextHighestPowerOfTwo(num: number): number {
    --num;
    for (let i = 1; i < 32; i <<= 1) {
        num = num | num >> i;
    }
    return num + 1;
  }

  private static isPowerOfTwo(num: number): boolean {
      return (num & (num - 1)) === 0;
  }

  private static resizeImageBytesToCanvas(imageBytes: Uint8Array, hasAlpha: boolean, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): HTMLCanvasElement | undefined {
    // ###TODO: would writing our own Uint8Array resize routine be faster than routing it through HTML canvas?
    if (srcWidth !== dstWidth || srcHeight !== dstHeight) {
      const canvas = document.createElement("canvas");
      canvas.width = srcWidth;
      canvas.height = srcHeight;
      const ctx = canvas.getContext("2d");
      const imageData = ctx !== null ? ctx.createImageData(srcWidth, srcHeight) : undefined;

      // store the image data in a HTMLCanvasElement
      if (undefined !== imageData && ctx !== null) {
        if (hasAlpha) {
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i + 0] = imageBytes[i + 0];
            imageData.data[i + 1] = imageBytes[i + 1];
            imageData.data[i + 2] = imageBytes[i + 2];
            imageData.data[i + 3] = imageBytes[i + 3];
          }
        } else {
          let ii = 0;
          for (let i = 0; i < imageData.data.length; i += 4, ii += 3) {
            imageData.data[i + 0] = imageBytes[ii + 0];
            imageData.data[i + 1] = imageBytes[ii + 1];
            imageData.data[i + 2] = imageBytes[ii + 2];
            imageData.data[i + 3] = 255;
          }
        }
        ctx.putImageData(imageData, 0, 0);

        // resize the image
        const resizedCanvas = document.createElement("canvas");
        resizedCanvas.width = dstWidth;
        resizedCanvas.height = dstHeight;
        const resizedCtx = resizedCanvas.getContext("2d");
        if (resizedCtx !== null) {
          resizedCtx.drawImage(canvas, 0, 0, resizedCanvas.width, resizedCanvas.height);
          return resizedCanvas;
        }
      }
    }
    return undefined;
  }
}
