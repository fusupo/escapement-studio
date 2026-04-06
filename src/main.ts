import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { getConfig } from "./config.js";

async function bootstrap() {
  const { port } = getConfig();
  const app = await NestFactory.create(AppModule, { cors: true });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Retry listen to survive restart races (nodemon, --watch, git pull)
  const maxRetries = 8;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await app.listen(port);
      console.log(`Escapement Studio server listening on http://localhost:${port}`);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < maxRetries) {
        const delay = attempt * 500;
        console.log(`Port ${port} in use, retrying in ${delay}ms... (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
