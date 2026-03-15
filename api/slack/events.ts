import { handleSlackEvents } from "../../lib/app";

export default {
  fetch(req: Request) {
    return handleSlackEvents(req);
  },
};
