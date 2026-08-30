export {
  TrajectoryAttributionContextSchema,
  type TrajectoryAttributionContext,
  type TrajectoryAttributionContextInput,
  TrajectoryValidationError,
  MixedTrajectoryIdentityError,
  TrajectoryAlreadyFinalizedError,
  computeTrajectoryObservationDigest,
  TrajectoryEmitter,
  createTrajectoryEmitter,
  aggregateTrajectoryEvents,
} from "./trajectory-emitter.js";

export {
  type TrajectoryAttributionResolverFn,
  type TrajectoryAttributionResolverObject,
  type TrajectoryAttributionResolver,
  type TrajectoryCaptureCoordinatorOptions,
  TrajectoryCaptureCoordinator,
} from "./capture-coordinator.js";

export {
  projectEventToMetadataOnly,
  projectEventMetadataOnly,
} from "./metadata-projection.js";
