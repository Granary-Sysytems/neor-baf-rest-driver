export function buildOpenApi(opts: { title: string; version: string }) {
  return {
    openapi: "3.0.3",
    info: {
      title: opts.title,
      version: opts.version,
      description:
        "Local REST driver for NEOR NW 500 document camera over UVC (FFmpeg AVFoundation on macOS).",
    },
    servers: [{ url: "http://127.0.0.1:8787" }],
    paths: {
      "/": {
        get: {
          summary: "Local test UI (HTML)",
          operationId: "getTestUi",
          responses: {
            "200": {
              description: "Single-page test console",
              content: {
                "text/html": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/health": {
        get: {
          summary: "Liveness probe",
          operationId: "getHealth",
          responses: {
            "200": {
              description: "Service is up",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      service: { type: "string" },
                      version: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/devices": {
        get: {
          summary: "List video capture devices",
          operationId: "listDevices",
          responses: {
            "200": {
              description: "Device list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      devices: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Device" },
                      },
                    },
                  },
                },
              },
            },
            "500": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/devices/{serial}": {
        get: {
          summary: "Get one device by serial",
          operationId: "getDevice",
          parameters: [
            {
              name: "serial",
              in: "path",
              required: true,
              schema: { type: "string", example: "DK50P30000422" },
            },
          ],
          responses: {
            "200": {
              description: "Device",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Device" },
                },
              },
            },
            "404": { $ref: "#/components/responses/Error" },
            "500": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/devices/{serial}/capture": {
        post: {
          summary: "Capture a still frame",
          operationId: "captureFrame",
          parameters: [
            {
              name: "serial",
              in: "path",
              required: true,
              schema: { type: "string", example: "DK50P30000422" },
            },
            {
              name: "Accept",
              in: "header",
              required: false,
              schema: {
                type: "string",
                enum: ["image/jpeg", "image/png", "application/json", "*/*"],
              },
              description:
                "image/* returns raw bytes; application/json returns base64 payload",
            },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CaptureRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Captured frame",
              content: {
                "image/jpeg": { schema: { type: "string", format: "binary" } },
                "image/png": { schema: { type: "string", format: "binary" } },
                "application/json": {
                  schema: { $ref: "#/components/schemas/CaptureJson" },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
            "404": { $ref: "#/components/responses/Error" },
            "500": { $ref: "#/components/responses/Error" },
            "504": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/devices/{serial}/light": {
        post: {
          summary: "Camera LED / lamp control",
          description:
            "On macOS UVC this returns 501 LIGHT_UNSUPPORTED. Vendor Set_Light_A/B is Windows OCX only.",
          operationId: "setDeviceLight",
          parameters: [
            {
              name: "serial",
              in: "path",
              required: true,
              schema: { type: "string", example: "DK50P30000422" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LightRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Light toggled (Windows sidecar only — not on macOS UVC)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      serial: { type: "string" },
                      on: { type: "boolean" },
                      mode: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": { $ref: "#/components/responses/Error" },
            "404": { $ref: "#/components/responses/Error" },
            "501": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI document",
          operationId: "getOpenApi",
          responses: {
            "200": {
              description: "OpenAPI 3 JSON",
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Device: {
          type: "object",
          properties: {
            index: { type: "integer" },
            name: { type: "string" },
            serial: { type: "string" },
            usbSerial: { type: "string", nullable: true },
            vendorId: { type: "integer", nullable: true },
            productId: { type: "integer", nullable: true },
            uniqueId: { type: "string", nullable: true },
            isTarget: { type: "boolean" },
            supportedModes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  width: { type: "integer" },
                  height: { type: "integer" },
                  fps: { type: "number" },
                },
              },
            },
          },
        },
        CaptureRequest: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
            autoCrop: {
              type: "boolean",
              default: false,
              description:
                "OpenCV document edge detect + perspective crop (default off)",
            },
            deskew: {
              type: "boolean",
              default: false,
              description:
                "Perspective straighten; same pipeline as autoCrop when either is true",
            },
          },
        },
        CaptureJson: {
          type: "object",
          properties: {
            format: { type: "string" },
            contentType: { type: "string" },
            width: { type: "integer" },
            height: { type: "integer" },
            serial: { type: "string" },
            encoding: { type: "string", example: "base64" },
            data: { type: "string", description: "Base64-encoded image bytes" },
            postprocess: {
              type: "object",
              nullable: true,
              properties: {
                applied: { type: "boolean" },
                method: { type: "string" },
                sourceWidth: { type: "integer" },
                sourceHeight: { type: "integer" },
              },
            },
          },
        },
        LightRequest: {
          type: "object",
          properties: {
            on: { type: "boolean" },
            mode: {
              type: "string",
              enum: ["A", "B", "ON", "OFF"],
              description: "Maps to vendor Set_Light_A / Set_Light_B when on Windows",
            },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        Error: {
          description: "Unified error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  };
}
