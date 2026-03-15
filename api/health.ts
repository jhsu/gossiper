import { handleHealth } from "../lib/app";

export default {
  fetch() {
    return handleHealth();
  },
};
