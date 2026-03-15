import { handleSlackInstall } from "../../lib/app";

export default {
  fetch() {
    return handleSlackInstall();
  },
};
