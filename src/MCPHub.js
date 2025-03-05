import logger from "./utils/logger.js";
import { ConfigManager } from "./utils/config.js";
import { MCPConnection } from "./MCPConnection.js";
import {
  ServerError,
  ConnectionError,
  ConfigError,
  wrapError,
} from "./utils/errors.js";

export class MCPHub {
  constructor(configPathOrObject, { watch = false } = {}) {
    this.connections = new Map();
    this.configManager = new ConfigManager(configPathOrObject);
    this.shouldWatchConfig = watch && typeof configPathOrObject === "string";
  }

  async initialize() {
    try {
      await this.configManager.loadConfig();

      if (this.shouldWatchConfig) {
        this.configManager.watchConfig();
        this.configManager.on("configChanged", async (newConfig) => {
          await this.updateConfig(newConfig);
        });
      }

      await this.startConfiguredServers();
    } catch (error) {
      // Only wrap if it's not already our error type
      if (!(error instanceof ConfigError)) {
        throw wrapError(error, "HUB_INIT_ERROR", {
          watchEnabled: this.shouldWatchConfig,
        });
      }
      throw error;
    }
  }

  async startConfiguredServers() {
    const config = this.configManager.getConfig();
    const servers = Object.entries(config?.mcpServers || {});
    logger.info(`Starting ${servers.length} configured MCP servers`, {
      count: servers.length,
    });

    for (const [name, serverConfig] of servers) {
      try {
        if (serverConfig.disabled === true) {
          logger.debug(`Skipping disabled MCP server '${name}'`, {
            server: name,
          });
        } else {
          logger.info(`Initializing MCP server '${name}'`, { server: name });
        }
        const connection = new MCPConnection(name, serverConfig);
        this.connections.set(name, connection);
        await connection.connect();
      } catch (error) {
        // Don't throw here as we want to continue with other servers
        logger.error(
          error.code || "SERVER_START_ERROR",
          "Failed to start server",
          {
            server: name,
            error: error.message,
          },
          false
        );
      }
    }
  }

  async startServer(name) {
    const config = this.configManager.getConfig();
    const serverConfig = config.mcpServers?.[name];
    if (!serverConfig) {
      throw new ServerError("Server not found", { server: name });
    }

    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server connection not found", { server: name });
    }

    // If server was disabled, update config
    if (serverConfig.disabled) {
      serverConfig.disabled = false;
      await this.configManager.updateConfig(config);
    }

    return await connection.start();
  }

  async stopServer(name, disable = false) {
    const config = this.configManager.getConfig();
    const serverConfig = config.mcpServers?.[name];
    if (!serverConfig) {
      throw new ServerError("Server not found", { server: name });
    }

    // If disabling, update config
    if (disable) {
      serverConfig.disabled = true;
      await this.configManager.updateConfig(config);
    }

    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server connection not found", { server: name });
    }

    return await connection.stop(disable);
  }

  async updateConfig(newConfigOrPath) {
    try {
      await this.configManager.updateConfig(newConfigOrPath);
      await this.startConfiguredServers();
    } catch (error) {
      throw wrapError(error, "CONFIG_UPDATE_ERROR", {
        isPathUpdate: typeof newConfigOrPath === "string",
      });
    }
  }

  async connectServer(name, config) {
    const connection = new MCPConnection(name, config);
    this.connections.set(name, connection);
    await connection.connect();
    return connection.getServerInfo();
  }

  async disconnectServer(name) {
    const connection = this.connections.get(name);
    if (connection) {
      try {
        await connection.disconnect();
      } catch (error) {
        // Log but don't throw since we're cleaning up
        logger.error(
          "SERVER_DISCONNECT_ERROR",
          "Error disconnecting server",
          {
            server: name,
            error: error.message,
          },
          false
        );
      }
      // Don't remove from connections map
    }
  }

  async disconnectAll() {
    logger.info(
      `Disconnecting all servers (${this.connections.size} active connections)`,
      {
        count: this.connections.size,
      }
    );

    const results = await Promise.allSettled(
      Array.from(this.connections.keys()).map((name) =>
        this.disconnectServer(name)
      )
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const name = Array.from(this.connections.keys())[index];
        logger.error(
          "SERVER_DISCONNECT_ERROR",
          "Failed to disconnect server during cleanup",
          {
            server: name,
            error: result.reason?.message || "Unknown error",
          },
          false
        );
      }
    });

    // Ensure connections map is cleared even if some disconnections failed
    this.connections.clear();
  }

  getServerStatus(name) {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new ServerError("Server not found", { server: name });
    }
    return connection.getServerInfo();
  }

  getAllServerStatuses() {
    return Array.from(this.connections.values()).map((connection) =>
      connection.getServerInfo()
    );
  }

  async callTool(serverName, toolName, args) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new ServerError("Server not found", {
        server: serverName,
        operation: "tool_call",
        tool: toolName,
      });
    }
    return await connection.callTool(toolName, args);
  }

  async readResource(serverName, uri) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new ServerError("Server not found", {
        server: serverName,
        operation: "resource_read",
        uri,
      });
    }
    return await connection.readResource(uri);
  }
}

export { MCPConnection } from "./MCPConnection.js";
