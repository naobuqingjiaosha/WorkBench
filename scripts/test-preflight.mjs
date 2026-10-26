// --import preloads run before any static imports in the test entry.
import {assertTestIsolation} from '../packages/server/src/core/test-isolation.ts';
assertTestIsolation(true);
