import { handleSlackCommands } from "../../lib/app";

export default {
  fetch(req: Request) {
    return handleSlackCommands(req);
  },
};
