/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import {
  FragmentShaderComponent,
  ProgramBuilder,
  ShaderType,
  VariablePrecision,
  VariableType,
  VertexShaderComponent,
} from "../ShaderBuilder";
import { WebGLContext } from "@itwin/webgl-compatibility";
import { ShaderProgram } from "../ShaderProgram";
import { AttributeMap } from "../AttributeMap";
import { AtmosphericScatteringViewportQuadGeometry } from "../CachedGeometry";
import { MAX_SAMPLE_POINTS, MESH_PROJECTION_CUTOFF_HEIGHT } from "../AtmosphericScatteringUniforms";

// #region GENERAL

const computeRayDir = `
vec3 computeRayDir(vec3 eyeSpace) {
  return u_isCameraEnabled ? normalize(eyeSpace) : vec3(0.0, 0.0, -1.0);
}
`;

const computeSceneDepthDefault = `
float computeSceneDepth(vec3 eyeSpace) {
  return u_isCameraEnabled ? length(eyeSpace) : -eyeSpace.z;
}
`;

const computeSceneDepthSky = `
float computeSceneDepth(vec3 eyeSpace) {
  return MAX_FLOAT;
}
`;

const computeRayOrigin = `
vec3 computeRayOrigin(vec3 eyeSpace) {
  return u_isCameraEnabled ? vec3(0.0) : vec3(eyeSpace.xy, 0.0);
}
`;

// #endregion GENERAL

// #region ELLIPSOID

/**
 * Computes the intersection of a ray with an ellipsoid and returns two values:
 * 1. The length from the ray's origin to the point it first intersects with the ellipsoid.
 * 2. The length from the first point the ray intersects with the sphere to the second point it intersects with the ellipsoid.
 *
 * @param ellipsoidCenter - Center of the ellipsoid in view coordinates.
 * @param inverseRotationMatrix - Transformation matrix to invert the ecdb to world and world to eye rotations.
 * @param ellipsoidScaleMatrix - Diagonal matrix where the diagonal represents the x, y and z radii of the ellipsoid.
 * @param inverseEllipsoidScaleMatrix - Transpose (also inverse) of the ellipsoidScaleMatrix.
 * @param rayOrigin - The starting point of the ray in eye space.
 * @param rayDir - The direction of the ray.
 * @returns A vec2 of float values representing the ray's distance to and through the ellipsoid.
 */
const rayEllipsoidIntersectionGeneric = `
vec2 rayEllipsoidIntersection(vec3 ellipsoidCenter, mat3 inverseRotationMatrix, mat3 ellipsoidScaleMatrix, mat3 inverseEllipsoidScaleMatrix, vec3 rayOrigin, vec3 rayDir) {
  vec3 ro, rd;

  // transform ray to be relative to sphere
  rd = inverseRotationMatrix * rayDir;
  ro = inverseRotationMatrix * (rayOrigin - ellipsoidCenter); // uniform for rayOrigin - ellipsoidCenter

  vec3 rdi = normalize(inverseEllipsoidScaleMatrix * rd);
  vec3 roi = inverseEllipsoidScaleMatrix * ro;

  vec2 toAndThrough = raySphere(vec3(0.0), 1.0, roi, rdi);
  if (toAndThrough[1] > 0.0) {
    vec3 pt = roi + rdi * toAndThrough[0];
    return vec2(
      distance(ro, ellipsoidScaleMatrix * pt),
      distance(ellipsoidScaleMatrix * pt, ellipsoidScaleMatrix * (pt + rdi * toAndThrough[1]))
    );
  }
  return toAndThrough;
}
`;

/**
 * Computes the intersection of a ray originating from the eye space origin (0.0, 0.0, 0.0) with the atmosphere ellipsoid:
 * 1. The length from the ray's origin to the point it first intersects with the ellipsoid.
 * 2. The length from the first point the ray intersects with the sphere to the second point it intersects with the ellipsoid.
 *
 * @param rayDir - The direction of the ray.
 * @returns A vec2 of float values representing the ray's distance to and through the ellipsoid.
 */
// const eyeAtmosphereIntersection = `
// vec2 eyeAtmosphereIntersection(vec3 rayDir, vec3 rayOrigin) {
//   return _eyeEllipsoidIntersection(
//     rayDir, rayOrigin, u_atmosphereToEyeInverseScaled, u_atmosphereScaleMatrix,
//     u_inverseRotationInverseAtmosphereScaleMatrix
//   );
// }
// `;

/**
 * Computes the intersection of a ray originating from the eye space origin (0.0, 0.0, 0.0) with the earth ellipsoid:
 * 1. The length from the ray's origin to the point it first intersects with the ellipsoid.
 * 2. The length from the first point the ray intersects with the sphere to the second point it intersects with the ellipsoid.
 *
 * @param rayDir - The direction of the ray.
 * @returns A vec2 of float values representing the ray's distance to and through the ellipsoid.
 */
// const eyeEarthIntersection = `
// vec2 eyeEarthIntersection(vec3 rayDir) {
//   return _eyeEllipsoidIntersection(
//     rayDir, u_earthToEyeInverseScaled, u_earthScaleMatrix,
//     u_inverseRotationInverseEarthScaleMatrix
//   );
// }
// `;

// const _eyeEllipsoidIntersection = `
// vec2 _eyeEllipsoidIntersection(vec3 rayDir, vec3 rayOriginToUnitSphere, mat3 ellipsoidScaleMatrix, mat3 inverseEllipsoidRotationAndScaleMatrix) {
//   // transform ray to be relative to sphere
//   vec3 rayDirToEllipsoid = normalize(inverseEllipsoidRotationAndScaleMatrix * rayDir);

//   vec2 toAndThrough = raySphere(vec3(0.0), 1.0, rayOriginToUnitSphere, rayDirToEllipsoid);
//   if (toAndThrough[1] > 0.0) {
//     vec3 point = rayDirToEllipsoid * toAndThrough[0] + rayOriginToUnitSphere;
//     vec3 scaledPoint = ellipsoidScaleMatrix * point;
//     return vec2(
//       distance(u_ellipsoidToEye, scaledPoint),
//       distance(scaledPoint, ellipsoidScaleMatrix * (rayDirToEllipsoid * toAndThrough[1] + point))
//     );
//   }
//   return toAndThrough;
// }
// `;

/**
 * Computes the intersection of a ray with a sphere and returns two values:
 * 1. The length from the ray's origin to the point it first intersects with the sphere.
 * 2. The length from the first point the ray intersects with the sphere to the second point it intersects with the sphere.
 *
 * @param sphereCenter - The center point of the sphere in eye space.
 * @param sphereRadius - The radius of the sphere.
 * @param rayOrigin - The starting point of the ray in eye space.
 * @param rayDir - The direction of the ray.
 * @returns A vec2 of float values representing the ray's distance to and through the sphere.
 */
const raySphere = `
vec2 raySphere(vec3 sphereCenter, float sphereRadius, vec3 rayOrigin, vec3 rayDir) {
  vec3 offset = rayOrigin - sphereCenter;
  float a = 1.0;
  float b = 2.0 * dot(offset, rayDir);
  float c = dot(offset, offset) - sphereRadius * sphereRadius;
  float d = b * b - 4.0 * a * c;
  if (d > 0.0) {
    float s = sqrt(d);
    float distanceToSphereNear = max(0.0, (-b - s) / (2.0 * a));
    float distanceToSphereFar = (-b + s) / (2.0 * a);
    if (distanceToSphereFar >= 0.0) {
      return vec2(distanceToSphereNear, distanceToSphereFar - distanceToSphereNear);
    }
  }
  return vec2(MAX_FLOAT, 0.0);
}
`;

/**
 * Returns the optical depth of a ray going through the atmosphere,
 * taking into account atmosphere density.
 *
 * @param rayOrigin - The starting point in eye space of the ray we calculate optical depth from.
 * @param rayDir - The direction of the ray.
 * @param rayLength - The length of the ray.
 * @returns A float in the range [0.0, rayLength] representing optical depth.
 */
const opticalDepth = `
float opticalDepth(vec3 rayOrigin, vec3 rayDir, float rayLength) {
  vec3 densitySamplePoint = rayOrigin;
  float stepSize = rayLength / (float(u_numOpticalDepthPoints) - 1.0);
  float opticalDepth = 0.0;
  vec3 rayStep = rayDir * stepSize;

  for (int i = 0; i < u_numOpticalDepthPoints; i ++) {
    float localDensity = densityAtPoint(densitySamplePoint);
    opticalDepth += localDensity;
    densitySamplePoint += rayStep;
  }
  return opticalDepth  * stepSize;
}
`;

/**
 * Returns the atmospheric density at a point according to its distance between
 * a minimum and maximum density height. Density decreases exponentially,
 * modulated by a density falloff coefficient.
 *
 * We find out at what ratio between the minimum density ellipsoid and the
 * maximum density ellipsoid (the atmosphere's limit) by squeezing the
 * coordinate space by the minimum density ellipsoid's scale factors, taking
 * the ellipsoid rotation into account. Then, we find out
 *
 * @param point - Point we want to sample density for.
 * @returns A density value between [0.0 - 1.0].
 */
const densityAtPoint = `
float densityAtPoint(vec3 point) {
  vec3 pointToMinDensityUnitSphere = u_inverseRotationInverseMinDensityScaleMatrix * (point - u_earthCenter);
  float atmosphereDistanceFromUnitSphere = u_minDensityToAtmosphereScaleFactor - 1.0;
  float distanceNotZero = atmosphereDistanceFromUnitSphere == 0.0 ? 0.0 : 1.0;
  float minToMaxRatio = distanceNotZero * (max(length(pointToMinDensityUnitSphere) - 1.0, 0.0) / atmosphereDistanceFromUnitSphere);
  return exp(-minToMaxRatio * u_densityFalloff) * (1.0 - minToMaxRatio);
}
`;

const computeInScatteredLightAndViewRayOpticalDepth = `
vec4 computeInScatteredLightAndViewRayOpticalDepth() {
  vec3 rayDir = computeRayDir(v_eyeSpace);
  vec3 rayOrigin = computeRayOrigin(v_eyeSpace);
  float sceneDepth = computeSceneDepth(v_eyeSpace);

  vec2 atmosphereHitInfo = rayEllipsoidIntersection(u_earthCenter, u_inverseEllipsoidRotationMatrix, u_atmosphereScaleMatrix, u_inverseAtmosphereScaleMatrix, rayOrigin, rayDir);
  vec2 earthHitInfo = rayEllipsoidIntersection(u_earthCenter, u_inverseEllipsoidRotationMatrix, u_earthScaleMatrix, u_inverseEarthScaleMatrix, rayOrigin, rayDir);

  float distanceThroughAtmosphere = min(
    atmosphereHitInfo[1],
    min(sceneDepth, earthHitInfo[0]) - atmosphereHitInfo[0] // PREVENTS GRID EFFECT
  );
  float distanceThroughEarth = min(earthHitInfo[1], sceneDepth - earthHitInfo[0]);

  vec3 inScatteredLight = vec3(0.0);
  float viewRayOpticalDepth = 0.0;
  if (distanceThroughAtmosphere - distanceThroughEarth > 0.0) {
    vec3 pointInAtmosphere = rayOrigin + rayDir * (atmosphereHitInfo[0] + EPSILON);
    float rayLength = distanceThroughAtmosphere - EPSILONx2;

    float stepSize = rayLength / (float(u_numInScatteringPoints) - 1.0);
    vec3 step = rayDir * stepSize;
    vec3 inScatterPoint = pointInAtmosphere;

    float viewRayOpticalDepthValues[MAX_SAMPLE_POINTS];
    vec3 viewRaySamplePoint = pointInAtmosphere + step;
    for (int i = 1; i < u_numInScatteringPoints; i++) {
      viewRayOpticalDepthValues[i-1] = densityAtPoint(viewRaySamplePoint) * stepSize;
      viewRaySamplePoint += step;
    }

    for (int i = 0; i < u_numInScatteringPoints; i++) {
      float sunRayLength = rayEllipsoidIntersection(u_earthCenter, u_inverseEllipsoidRotationMatrix, u_atmosphereScaleMatrix, u_inverseAtmosphereScaleMatrix, inScatterPoint, u_sunDir)[1];
      float sunRayOpticalDepth = opticalDepth(inScatterPoint, u_sunDir, sunRayLength);
      viewRayOpticalDepth = 0.0;
      for (int j = 0; j < i; j++) {
        viewRayOpticalDepth += viewRayOpticalDepthValues[j];
      }
      vec3 transmittance = exp(-((sunRayOpticalDepth + viewRayOpticalDepth) / u_earthScaleMatrix[2][2]) * u_scatteringCoefficients);

      inScatteredLight += densityAtPoint(inScatterPoint) * transmittance;
      inScatterPoint += step;
    }
    inScatteredLight *= u_scatteringCoefficients * u_inScatteringIntensity * stepSize / u_earthScaleMatrix[2][2];
  }
  return vec4(inScatteredLight.rgb, viewRayOpticalDepth);
}
`;

const computeReflectedLight = `
vec3 computeReflectedLight(vec3 inScatteredLight, float viewRayOpticalDepth, vec3 baseColor) {
  float reflectedLightOutScatterStrength = 3.0;
  float brightnessAdaption = (inScatteredLight.r + inScatteredLight.g + inScatteredLight.b) * u_brightnessAdaptionStrength;
  float brightnessSum = viewRayOpticalDepth / u_earthScaleMatrix[2][2] * u_outScatteringIntensity * reflectedLightOutScatterStrength + brightnessAdaption;
  float reflectedLightStrength = exp(-brightnessSum);
  float hdrStrength = clamp((baseColor.r + baseColor.g + baseColor.b) / 3.0 - 1.0, 0.0, 1.0);
  reflectedLightStrength = mix(reflectedLightStrength, 1.0, hdrStrength);
  return baseColor * reflectedLightStrength;
}
`;

/**
 *   // We get the distance the ray traveled from the eye to the atmosphere and
  // the distance it traveled in the atmosphere to reach the fragment.
 *
 */
const computeAtmosphericScatteringFromVaryings = `
vec4 computeAtmosphericScattering(vec4 baseColor) {
  vec3 reflectedLight = computeReflectedLight(v_inScatteredLight, v_viewRayOpticalDepth, baseColor.rgb);
  return vec4(reflectedLight + v_inScatteredLight, baseColor.a);
}
`;

const computeAtmosphericScatteringFromScratch = `
vec4 computeAtmosphericScattering(vec4 baseColor) {
  vec4 values = computeInScatteredLightAndViewRayOpticalDepth();
  vec3 inScatteredLight = values.xyz;
  float viewRayOpticalDepth = values.w;
  vec3 reflectedLight = computeReflectedLight(inScatteredLight, viewRayOpticalDepth, baseColor.rgb);
  return vec4(reflectedLight + inScatteredLight, baseColor.a);
}
`;

const inlineComputeAtmosphericScatteringVaryings = "computeAtmosphericScatteringVaryings();";

const computeAtmosphericScatteringVaryings = `
void computeAtmosphericScatteringVaryings() {
  vec4 values = computeInScatteredLightAndViewRayOpticalDepth();
  v_inScatteredLight = values.xyz;
  v_viewRayOpticalDepth = values.w;
}`;
// #endregion ELLIPSOID

// #region MAIN
const applyAtmosphericScattering = `
  // return baseColor if atmospheric scattering is disabled
  if (!bool(u_isEnabled))
    return baseColor;
  return computeAtmosphericScattering(baseColor);
`;

/** @internal */
export function addAtmosphericScatteringEffect(
  builder: ProgramBuilder,
  isSky = false,
) {
  if (isSky)
    addAtmosphericScatteringEffectPerFragment(builder, isSky);
  else
    addAtmosphericScatteringEffectPerVertex(builder, isSky);
}

function addAtmosphericScatteringEffectPerFragment(builder: ProgramBuilder, isSky: boolean) {
  const frag = builder.frag;

  frag.addConstant("PI", VariableType.Float, "3.14159265359");
  frag.addConstant("EPSILON", VariableType.Float, "0.000001");
  frag.addConstant("EPSILONx2", VariableType.Float, "EPSILON * 2.0");
  frag.addConstant("MAX_FLOAT", VariableType.Float, "3.402823466e+38");
  frag.addConstant("MAX_SAMPLE_POINTS", VariableType.Int, `${MAX_SAMPLE_POINTS}`);
  frag.addConstant("MESH_PROJECTION_CUTOFF_HEIGHT", VariableType.Float, `${MESH_PROJECTION_CUTOFF_HEIGHT}.0`);

  frag.addUniform(
    "u_densityFalloff",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_densityFalloff", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindDensityFalloff(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_scatteringCoefficients",
    VariableType.Vec3,
    (prog) => {
      prog.addProgramUniform("u_scatteringCoefficients", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindScatteringCoefficients(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_numInScatteringPoints",
    VariableType.Int,
    (prog) => {
      prog.addProgramUniform("u_numInScatteringPoints", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindNumInScatteringPoints(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_numOpticalDepthPoints",
    VariableType.Int,
    (prog) => {
      prog.addProgramUniform("u_numOpticalDepthPoints", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindNumOpticalDepthPoints(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_sunDir",
    VariableType.Vec3,
    (prog) => {
      prog.addProgramUniform("u_sunDir", (uniform, params) => {
        params.target.uniforms.bindSunDirection(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_earthCenter",
    VariableType.Vec3,
    (prog) => {
      prog.addProgramUniform("u_earthCenter", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindEarthCenter(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_inverseEllipsoidRotationMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseEllipsoidRotationMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseEllipsoidRotationMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  // frag.addUniform(
  //   "u_ellipsoidToEye",
  //   VariableType.Vec3,
  //   (prog) => {
  //     prog.addProgramUniform("u_ellipsoidToEye", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindEllipsoidToEye(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  frag.addUniform(
    "u_atmosphereScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_atmosphereScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindAtmosphereScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_inverseAtmosphereScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseAtmosphereScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseAtmosphereScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  // frag.addUniform(
  //   "u_atmosphereToEyeInverseScaled",
  //   VariableType.Vec3,
  //   (prog) => {
  //     prog.addProgramUniform("u_atmosphereToEyeInverseScaled", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindAtmosphereToEyeInverseScaled(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  frag.addUniform(
    "u_minDensityToAtmosphereScaleFactor",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_minDensityToAtmosphereScaleFactor", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindMinDensityToAtmosphereScaleFactor(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_inScatteringIntensity",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_inScatteringIntensity", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInScatteringIntensity(uniform);
      });
    },
    VariablePrecision.High
  );
  // frag.addUniform(
  //   "u_earthToEyeInverseScaled",
  //   VariableType.Vec3,
  //   (prog) => {
  //     prog.addProgramUniform("u_earthToEyeInverseScaled", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindEarthToEyeInverseScaled(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  // frag.addUniform(
  //   "u_inverseRotationInverseAtmosphereScaleMatrix",
  //   VariableType.Mat3,
  //   (prog) => {
  //     prog.addProgramUniform("u_inverseRotationInverseAtmosphereScaleMatrix", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindInverseRotationInverseAtmosphereScaleMatrix(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  // frag.addUniform(
  //   "u_inverseRotationInverseEarthScaleMatrix",
  //   VariableType.Mat3,
  //   (prog) => {
  //     prog.addProgramUniform("u_inverseRotationInverseEarthScaleMatrix", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindInverseRotationInverseEarthScaleMatrix(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  frag.addUniform(
    "u_inverseRotationInverseMinDensityScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseRotationInverseMinDensityScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseRotationInverseMinDensityScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_earthScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_earthScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindEarthScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_inverseEarthScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseEarthScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseEarthScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_isEnabled",
    VariableType.Int,
    (prog) => {
      prog.addProgramUniform("u_isEnabled", (uniform, params) => {
        uniform.setUniform1i(
          params.target.plan.viewFlags.atmosphericScattering ? 1 : 0
        );
      });
    },
    VariablePrecision.Low
  );
  frag.addUniform(
    "u_brightnessAdaptionStrength",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_brightnessAdaptionStrength", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindBrightnessAdaptationStrength(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_outScatteringIntensity",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_outScatteringIntensity", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindOutScatteringIntensity(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_isCameraEnabled",
    VariableType.Boolean,
    (prog) => {
      prog.addProgramUniform("u_isCameraEnabled", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindIsCameraEnabled(uniform);
      });
    }
  );

  frag.addFunction(computeRayDir);
  frag.addFunction(computeRayOrigin);
  if (isSky) {
    frag.addFunction(computeSceneDepthSky);
  } else {
    frag.addFunction(computeSceneDepthDefault);
  }
  frag.addFunction(raySphere);
  // frag.addFunction(_eyeEllipsoidIntersection);
  frag.addFunction(densityAtPoint);
  frag.addFunction(rayEllipsoidIntersectionGeneric);
  // frag.addFunction(eyeAtmosphereIntersection);
  // frag.addFunction(eyeEarthIntersection);
  frag.addFunction(opticalDepth);
  frag.addFunction(computeInScatteredLightAndViewRayOpticalDepth);
  frag.addFunction(computeReflectedLight);
  frag.addFunction(computeAtmosphericScatteringFromScratch);

  frag.set(
    FragmentShaderComponent.ApplyAtmosphericScattering,
    applyAtmosphericScattering
  );

}

function addAtmosphericScatteringEffectPerVertex(builder: ProgramBuilder, isSky: boolean) {
  const vert = builder.vert;
  const frag = builder.frag;

  builder.addUniform(
    "u_earthScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_earthScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindEarthScaleMatrix(uniform);
      });
    },
    ShaderType.Both
  );
  builder.addUniform(
    "u_isEnabled",
    VariableType.Int,
    (prog) => {
      prog.addProgramUniform("u_isEnabled", (uniform, params) => {
        uniform.setUniform1i(
          params.target.plan.viewFlags.atmosphericScattering ? 1 : 0
        );
      });
    },
    ShaderType.Both
  );

  vert.addConstant("PI", VariableType.Float, "3.14159265359");
  vert.addConstant("EPSILON", VariableType.Float, "0.000001");
  vert.addConstant("EPSILONx2", VariableType.Float, "EPSILON * 2.0");
  vert.addConstant("MAX_FLOAT", VariableType.Float, "3.402823466e+38");
  vert.addConstant("MAX_SAMPLE_POINTS", VariableType.Int, `${MAX_SAMPLE_POINTS}`);
  vert.addConstant("MESH_PROJECTION_CUTOFF_HEIGHT", VariableType.Float, `${MESH_PROJECTION_CUTOFF_HEIGHT}.0`);

  vert.addUniform(
    "u_densityFalloff",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_densityFalloff", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindDensityFalloff(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_scatteringCoefficients",
    VariableType.Vec3,
    (prog) => {
      prog.addProgramUniform("u_scatteringCoefficients", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindScatteringCoefficients(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_numInScatteringPoints",
    VariableType.Int,
    (prog) => {
      prog.addProgramUniform("u_numInScatteringPoints", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindNumInScatteringPoints(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_numOpticalDepthPoints",
    VariableType.Int,
    (prog) => {
      prog.addProgramUniform("u_numOpticalDepthPoints", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindNumOpticalDepthPoints(
          uniform
        );
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_sunDir",
    VariableType.Vec3,
    (prog) => {
      prog.addProgramUniform("u_sunDir", (uniform, params) => {
        params.target.uniforms.bindSunDirection(uniform);
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_earthCenter",
    VariableType.Vec3,
    (prog) => {
      prog.addProgramUniform("u_earthCenter", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindEarthCenter(uniform);
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_inverseEllipsoidRotationMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseEllipsoidRotationMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseEllipsoidRotationMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  // vert.addUniform(
  //   "u_ellipsoidToEye",
  //   VariableType.Vec3,
  //   (prog) => {
  //     prog.addProgramUniform("u_ellipsoidToEye", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindEllipsoidToEye(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  vert.addUniform(
    "u_atmosphereScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_atmosphereScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindAtmosphereScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_inverseAtmosphereScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseAtmosphereScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseAtmosphereScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  // vert.addUniform(
  //   "u_atmosphereToEyeInverseScaled",
  //   VariableType.Vec3,
  //   (prog) => {
  //     prog.addProgramUniform("u_atmosphereToEyeInverseScaled", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindAtmosphereToEyeInverseScaled(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  vert.addUniform(
    "u_minDensityToAtmosphereScaleFactor",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_minDensityToAtmosphereScaleFactor", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindMinDensityToAtmosphereScaleFactor(uniform);
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_inScatteringIntensity",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_inScatteringIntensity", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInScatteringIntensity(uniform);
      });
    },
    VariablePrecision.High
  );
  // vert.addUniform(
  //   "u_earthToEyeInverseScaled",
  //   VariableType.Vec3,
  //   (prog) => {
  //     prog.addProgramUniform("u_earthToEyeInverseScaled", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindEarthToEyeInverseScaled(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  // vert.addUniform(
  //   "u_inverseRotationInverseAtmosphereScaleMatrix",
  //   VariableType.Mat3,
  //   (prog) => {
  //     prog.addProgramUniform("u_inverseRotationInverseAtmosphereScaleMatrix", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindInverseRotationInverseAtmosphereScaleMatrix(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  // vert.addUniform(
  //   "u_inverseRotationInverseEarthScaleMatrix",
  //   VariableType.Mat3,
  //   (prog) => {
  //     prog.addProgramUniform("u_inverseRotationInverseEarthScaleMatrix", (uniform, params) => {
  //       params.target.uniforms.atmosphericScattering.bindInverseRotationInverseEarthScaleMatrix(uniform);
  //     });
  //   },
  //   VariablePrecision.High
  // );
  vert.addUniform(
    "u_inverseRotationInverseMinDensityScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseRotationInverseMinDensityScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseRotationInverseMinDensityScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );
  vert.addUniform(
    "u_isCameraEnabled",
    VariableType.Boolean,
    (prog) => {
      prog.addProgramUniform("u_isCameraEnabled", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindIsCameraEnabled(uniform);
      });
    }
  );
  vert.addUniform(
    "u_inverseEarthScaleMatrix",
    VariableType.Mat3,
    (prog) => {
      prog.addProgramUniform("u_inverseEarthScaleMatrix", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindInverseEarthScaleMatrix(uniform);
      });
    },
    VariablePrecision.High
  );

  vert.addFunction(computeRayOrigin);
  vert.addFunction(computeRayDir);
  if (isSky) {
    vert.addFunction(computeSceneDepthSky);
  } else {
    vert.addFunction(computeSceneDepthDefault);
  }
  vert.addFunction(raySphere);
  // vert.addFunction(_eyeEllipsoidIntersection);
  vert.addFunction(densityAtPoint);
  vert.addFunction(rayEllipsoidIntersectionGeneric);
  // vert.addFunction(eyeAtmosphereIntersection);
  // vert.addFunction(eyeEarthIntersection);
  vert.addFunction(opticalDepth);
  vert.addFunction(computeInScatteredLightAndViewRayOpticalDepth);
  vert.addFunction(computeAtmosphericScatteringVaryings);

  builder.addVarying("v_viewRayOpticalDepth", VariableType.Float);
  builder.addInlineComputedVarying("v_inScatteredLight", VariableType.Vec3, inlineComputeAtmosphericScatteringVaryings);

  frag.addUniform(
    "u_brightnessAdaptionStrength",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_brightnessAdaptionStrength", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindBrightnessAdaptationStrength(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addUniform(
    "u_outScatteringIntensity",
    VariableType.Float,
    (prog) => {
      prog.addProgramUniform("u_outScatteringIntensity", (uniform, params) => {
        params.target.uniforms.atmosphericScattering.bindOutScatteringIntensity(uniform);
      });
    },
    VariablePrecision.High
  );
  frag.addFunction(computeReflectedLight);
  frag.addFunction(computeAtmosphericScatteringFromVaryings);

  frag.set(
    FragmentShaderComponent.ApplyAtmosphericScattering,
    applyAtmosphericScattering
  );
}

// #endregion MAIN

// #region QUAD
const computeBaseColorVS = `return vec4(u_skyColor.xyz, 1.0);`;
const computeBaseColorFS = `return v_color;`;
const assignFragData = `FragColor = baseColor;`;
const computePosition = `return rawPos;`;
const computeEyeSpace = `
vec3 computeEyeSpace(vec4 rawPos) {
  vec3 pos01 = rawPos.xyz * 0.5 + 0.5;

  float top = u_frustumPlanes.x;
  float bottom = u_frustumPlanes.y;
  float left = u_frustumPlanes.z;
  float right = u_frustumPlanes.w;

  return vec3(
    mix(left, right, pos01.x),
    mix(bottom, top, pos01.y),
    -u_frustum.x
  );
}`;

/** @internal */
export function createAtmosphericSkyProgram(
  context: WebGLContext
): ShaderProgram {
  const prog = new ProgramBuilder(
    AttributeMap.findAttributeMap(undefined, false)
  );

  prog.vert.addUniform("u_frustumPlanes", VariableType.Vec4, (prg) => {
    prg.addGraphicUniform("u_frustumPlanes", (uniform, params) => {
      uniform.setUniform4fv(params.target.uniforms.frustum.planes); // { top, bottom, left, right }
    });
  });
  prog.vert.addUniform("u_frustum", VariableType.Vec3, (prg) => {
    prg.addGraphicUniform("u_frustum", (uniform, params) => {
      uniform.setUniform3fv(params.target.uniforms.frustum.frustum); // { near, far, type }
    });
  });
  prog.vert.addUniform("u_skyColor", VariableType.Vec3, (shader) => {
    shader.addGraphicUniform("u_skyColor", (uniform, params) => {
      const geom = params.geometry as AtmosphericScatteringViewportQuadGeometry;
      uniform.setUniform3fv(geom.atmosphericSkyColor);
    });
  });
  prog.vert.addFunction(computeEyeSpace);

  prog.vert.set(VertexShaderComponent.ComputePosition, computePosition);
  prog.vert.set(VertexShaderComponent.ComputeBaseColor, computeBaseColorVS);

  prog.frag.set(FragmentShaderComponent.AssignFragData, assignFragData);
  prog.frag.set(FragmentShaderComponent.ComputeBaseColor, computeBaseColorFS);

  prog.addInlineComputedVarying("v_eyeSpace", VariableType.Vec3, "v_eyeSpace = computeEyeSpace(rawPosition);");
  prog.addVarying("v_color", VariableType.Vec4);

  addAtmosphericScatteringEffect(prog, true);

  prog.vert.headerComment = "//!V! AtmosphericSky";
  prog.frag.headerComment = "//!F! AtmosphericSky";

  return prog.buildProgram(context);
}
// #endregion QUAD
