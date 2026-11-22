// A loading state per section: on a client navigation only the part below the shared layout re-renders,
// so each section needs its own boundary for the switch to be instant (Next instant navigation).
export { default } from "../../loading";
