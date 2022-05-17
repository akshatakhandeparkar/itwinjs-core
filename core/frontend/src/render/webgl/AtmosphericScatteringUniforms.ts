/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { Point3d, Transform } from "@itwin/core-geometry";
import { AtmosphericScattering } from "@itwin/core-common";
import { WebGLDisposable } from "./Disposable";
import { desync, sync } from "./Sync";
import { Target } from "./Target";
import { UniformHandle } from "./UniformHandle";

export class AtmosphericScatteringUniforms implements WebGLDisposable {
  private readonly _earthCenter = new Float32Array(3);
  private _atmosphericScattering?: AtmosphericScattering;
  private _scratchPoint3d = new Point3d();
  private _atmosphereRadius = 0.0;
  private _earthRadius = 0.0;
  private _scatteringCoefficients = new Float32Array(3);
  private _densityFalloff = 0.0;
  private _numInScatteringPoints = 0.0;
  private _numOpticalDepthPoints = 0.0;
  private _isPlanar = false;

  public syncKey = 0;

  public get atmosphericScattering(): AtmosphericScattering | undefined {
    return this._atmosphericScattering;
  }

  public update(target: Target): void {
    const plan = target.plan;
    desync(this);
    if (!(this.atmosphericScattering && plan.atmosphericScattering && this.atmosphericScattering.equals(plan.atmosphericScattering))) {
      this._atmosphericScattering = plan.atmosphericScattering;
    }

    if (!this.atmosphericScattering) {
      return;
    }
    this._updateEarthCenter(this.atmosphericScattering.earthCenter, target.uniforms.frustum.viewMatrix);
    this._updateAtmosphereRadius(this.atmosphericScattering.atmosphereRadius);
    this._updateEarthRadius(this.atmosphericScattering.earthRadius);
    this._updateDensityFalloff(this.atmosphericScattering.densityFalloff);
    this._updateScatteringCoefficients(this.atmosphericScattering.scatteringStrength, this.atmosphericScattering.wavelenghts);
    this._updateNumInScatteringPoints(this.atmosphericScattering.numInScatteringPoints);
    this._updateNumOpticalDepthPoints(this.atmosphericScattering.numOpticalDepthPoints);
    this._updateIsPlanar(this.atmosphericScattering.isPlanar);
  }

  private _updateEarthCenter(earthCenter: Point3d, viewMatrix: Transform) {
    viewMatrix.multiplyPoint3d(earthCenter, this._scratchPoint3d);
    this._earthCenter[0] = this._scratchPoint3d.x;
    this._earthCenter[1] = this._scratchPoint3d.y;
    this._earthCenter[2] = this._scratchPoint3d.z;
  }

  private _updateAtmosphereRadius(radius: number) {
    this._atmosphereRadius = radius;
  }

  private _updateEarthRadius(radius: number) {
    this._earthRadius = radius;
  }

  private _updateScatteringCoefficients(scatteringStrength: number, wavelenghts: number[]) {
    this._scatteringCoefficients[0] = ((400.0 / wavelenghts[0]) ** 4.0) * scatteringStrength;
    this._scatteringCoefficients[1] = ((400.0 / wavelenghts[1]) ** 4.0) * scatteringStrength;
    this._scatteringCoefficients[2] = ((400.0 / wavelenghts[2]) ** 4.0) * scatteringStrength;
  }

  private _updateDensityFalloff(densityFalloff: number) {
    this._densityFalloff = densityFalloff;
  }

  private _updateNumInScatteringPoints(numInScatteringPoints: number) {
    this._numInScatteringPoints = numInScatteringPoints;
  }

  private _updateNumOpticalDepthPoints(numOpticalDepthPoints: number) {
    this._numOpticalDepthPoints = numOpticalDepthPoints;
  }

  private _updateIsPlanar(isPlanar: boolean) {
    this._isPlanar = isPlanar;
  }

  public bindEarthCenter(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform3fv(this._earthCenter);
  }

  public bindAtmosphereRadius(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform1f(this._atmosphereRadius);
  }

  public bindEarthRadius(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform1f(this._earthRadius);
  }

  public bindDensityFalloff(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform1f(this._densityFalloff);
  }

  public bindScatteringCoefficients(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform3fv(this._scatteringCoefficients);
  }

  public bindNumInScatteringPoints(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform1i(this._numInScatteringPoints);
  }

  public bindNumOpticalDepthPoints(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform1i(this._numOpticalDepthPoints);
  }

  public bindIsPlanar(uniform: UniformHandle): void {
    if (!sync(this, uniform))
      uniform.setUniform1i(this._isPlanar ? 1 : 0);
  }

  public get isDisposed(): boolean {
    return true;
  }

  public dispose() {}
}
