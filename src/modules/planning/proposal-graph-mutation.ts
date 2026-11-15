import { BadRequestException } from "@nestjs/common";
import type {
  CreateEdgeDto,
  CreateWorkItemDto,
  DeleteEdgeMutation,
  DeleteWorkItemMutation,
  EdgeRel,
  GraphMutation,
  UpdateWorkItemDto,
} from "../graph/types.js";
import type {
  CreateEdgePayload,
  CreateWorkItemPayload,
  PlanningMutationProposalMutation,
  UpdateWorkItemPayload,
} from "./types.js";

/**
 * Convert one reviewed proposal mutation into the graph writer's
 * mutation. Moved out of `PlanningService` (#281) so the import
 * proposal builder can validate a proposal the same way approval
 * applies it. Throws 400 when the payload lacks required fields.
 */
export function toGraphMutation(mutation: PlanningMutationProposalMutation): GraphMutation {
  switch (mutation.type) {
    case "create_work_item": {
      const payload = mutation.payload as CreateWorkItemPayload | undefined;
      const id = mutation.entity_id ?? payload?.id;
      if (!id || !payload?.name || !payload.kind) {
        throw new BadRequestException(`Mutation ${mutation.id} is missing create_work_item payload fields`);
      }
      const workItem: CreateWorkItemDto = {
        ...payload,
        id,
        name: payload.name,
        kind: payload.kind,
      };
      return {
        mutation_id: mutation.id,
        kind: "create_work_item",
        work_item: workItem,
      };
    }

    case "update_work_item": {
      const id = mutation.entity_id;
      if (!id || !mutation.payload) {
        throw new BadRequestException(`Mutation ${mutation.id} is missing update_work_item payload fields`);
      }
      return {
        mutation_id: mutation.id,
        kind: "update_work_item",
        id,
        patch: mutation.payload as UpdateWorkItemDto,
      };
    }

    case "delete_work_item": {
      const id = mutation.entity_id;
      if (!id) {
        throw new BadRequestException(`Mutation ${mutation.id} is missing delete_work_item entity_id`);
      }
      const deleteMutation: DeleteWorkItemMutation = {
        mutation_id: mutation.id,
        kind: "delete_work_item",
        id,
      };
      return deleteMutation;
    }

    case "create_edge": {
      const payload = mutation.payload as CreateEdgePayload | undefined;
      if (!payload?.from_id || !payload.rel || !payload.to_id) {
        throw new BadRequestException(`Mutation ${mutation.id} is missing create_edge payload fields`);
      }
      const edge: CreateEdgeDto = {
        from_id: payload.from_id,
        rel: payload.rel as EdgeRel,
        to_id: payload.to_id,
        confidence: payload.confidence,
        meta: payload.meta,
      };
      return {
        mutation_id: mutation.id,
        kind: "create_edge",
        edge,
      };
    }

    case "delete_edge": {
      const payloadId = typeof mutation.payload?.id === "number"
        ? mutation.payload.id
        : typeof mutation.entity_id === "string"
          ? Number(mutation.entity_id)
          : Number.NaN;

      if (!Number.isInteger(payloadId)) {
        throw new BadRequestException(`Mutation ${mutation.id} is missing delete_edge id`);
      }

      const deleteMutation: DeleteEdgeMutation = {
        mutation_id: mutation.id,
        kind: "delete_edge",
        id: payloadId,
      };
      return deleteMutation;
    }
  }
}
