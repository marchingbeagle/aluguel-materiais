"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// API minima e segura exposta ao renderer. Nenhum acesso direto a ipcRenderer
// ou ao filesystem fica disponivel na pagina.
contextBridge.exposeInMainWorld("api", {
  // Configuracoes / arquivos
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseDir: () => ipcRenderer.invoke("settings:chooseDir"),
  validateFiles: () => ipcRenderer.invoke("files:validate"),

  // Dados
  loadAll: () => ipcRenderer.invoke("data:loadAll"),

  // Materiais
  createMaterial: (data) => ipcRenderer.invoke("material:create", data),
  updateMaterial: (data) => ipcRenderer.invoke("material:update", data),
  deleteMaterial: (id) => ipcRenderer.invoke("material:delete", id),

  // Agencias
  createAgency: (data) => ipcRenderer.invoke("agency:create", data),
  updateAgency: (data) => ipcRenderer.invoke("agency:update", data),
  deleteAgency: (id) => ipcRenderer.invoke("agency:delete", id),

  // Alugueis
  createRental: (data) => ipcRenderer.invoke("rental:create", data),
  updateRental: (data) => ipcRenderer.invoke("rental:update", data),
  returnRental: (payload) => ipcRenderer.invoke("rental:return", payload),
  deleteRental: (id) => ipcRenderer.invoke("rental:delete", id),

  // Avisos de mudanca externa (auto-refresh). Retorna funcao para cancelar.
  onDataChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  },
});
