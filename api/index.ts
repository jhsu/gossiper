import { handleHomepage } from "../lib/app";

export default {
  fetch() {
    return handleHomepage();
  },
};
