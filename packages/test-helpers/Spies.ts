/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import * as chai from "chai";
import * as spies from "chai-spies";

chai.use(spies);

beforeEach(() => {
  // @types don't export `restore`...
  (chai.spy as any).restore();
});

export { spy } from "chai";
