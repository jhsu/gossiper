import { handleSlackOAuthCallback } from "../../../lib/app";

export default {
  fetch(req: Request) {
    return handleSlackOAuthCallback(req);
  },
};
