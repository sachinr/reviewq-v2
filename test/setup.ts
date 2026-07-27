// Jest global setup. Reset the deterministic id sequence used by fakes before
// each test so ids are stable and independent across tests.
import { resetSeq } from "./fakes";

beforeEach(() => {
  resetSeq();
});
