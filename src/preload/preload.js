"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// API minima e segura exposta ao renderer. Nenhum acesso direto a ipcRenderer
// ou ao filesystem fica disponivel na pagina.
contextBridge.exposeInMainWorld("api", {
  // Configuracoes / arquivos
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseDir: () => ipcRenderer.invoke("settings:chooseDir"),
  validateFiles: () => ipcRenderer.invoke("files:validate"),
  importStockCsv: (kind) => ipcRenderer.invoke("stock:importCsv", kind),
  downloadStockTemplate: (kind) => ipcRenderer.invoke("stock:template", kind),

  // Dados
  loadAll: () => ipcRenderer.invoke("data:loadAll"),

  // Disponibilidade de materiais em um periodo (para o formulario de aluguel).
  getAvailability: (params) => ipcRenderer.invoke("rentals:availability", params),

  // Materiais
  createMaterial: (data) => ipcRenderer.invoke("material:create", data),
  updateMaterial: (data) => ipcRenderer.invoke("material:update", data),
  deleteMaterial: (id) => ipcRenderer.invoke("material:delete", id),

  // Estoque de produtos
  createStockProduct: (data) => ipcRenderer.invoke("stockProduct:create", data),
  updateStockProduct: (data) => ipcRenderer.invoke("stockProduct:update", data),
  deleteStockProduct: (id) => ipcRenderer.invoke("stockProduct:delete", id),
  createStockMovement: (data) => ipcRenderer.invoke("stockMovement:create", data),
  updateStockMovement: (data) => ipcRenderer.invoke("stockMovement:update", data),
  deleteStockMovement: (id) => ipcRenderer.invoke("stockMovement:delete", id),

  // Agencias
  createAgency: (data) => ipcRenderer.invoke("agency:create", data),
  updateAgency: (data) => ipcRenderer.invoke("agency:update", data),
  deleteAgency: (id) => ipcRenderer.invoke("agency:delete", id),

  // Alugueis (multiplos materiais por aluguel)
  createRental: (data) => ipcRenderer.invoke("rental:create", data),
  updateRental: (data) => ipcRenderer.invoke("rental:update", data),
  returnRental: (payload) => ipcRenderer.invoke("rental:return", payload),
  deleteRental: (id) => ipcRenderer.invoke("rental:delete", id),

  // Anexos
  pickAttachments: () => ipcRenderer.invoke("attachment:pick"),
  addAttachments: (payload) => ipcRenderer.invoke("attachment:add", payload),
  removeAttachment: (id) => ipcRenderer.invoke("attachment:remove", id),
  openAttachment: (id) => ipcRenderer.invoke("attachment:open", id),

  // Avisos de mudanca externa (auto-refresh). Retorna funcao para cancelar.
  onDataChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  },
});
