/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module PresentationRules
 */

import { RelationshipPathSpecification } from "./RelationshipPathSpecification";

/**
 * Related instance specification is used in [content]($docs/presentation/content/ContentRule.md#attribute-specifications)
 * and [hierarchy]($docs/presentation/hierarchies/ChildNodeRule.md#attribute-specifications) specifications to "join" the
 * primary instance with its related instance and allow using the related instance for filtering, customization and grouping.
 *
 * @see [Related instance specification reference documentation page]($docs/presentation/RelatedInstanceSpecification.md)
 * @public
 */
export interface RelatedInstanceSpecification {
  /**
   * Specifies a chain of [relationship path specifications]($docs/presentation/RelationshipPathSpecification.md)
   * that forms a path from the primary instance to the related instances.
   */
  relationshipPath: RelationshipPathSpecification;

  /**
   * Specifies an an alias that given to the related instance. The alias can be used to reference the
   * instance in instance filter and customization rules.
   *
   * @pattern ^\w[\w\d]*$
   */
  alias: string;

  /**
   * Specifies whether to omit the primary instance from the result if the other end of [[relationshipPath]]
   * does not yield any related instances.
   */
  isRequired?: boolean;
}
