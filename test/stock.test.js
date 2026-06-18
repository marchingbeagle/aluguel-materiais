"use strict";

const stock = require("../src/main/stock");

describe("stock", () => {
  test("parseia datas seriais do Excel e datas BR", () => {
    expect(stock.parseDate(45741)).toBe("2025-03-25");
    expect(stock.parseDate("25/03/2025")).toBe("2025-03-25");
    expect(stock.parseDate("2025-02-31")).toBe("");
  });

  test("importa produtos com cabecalhos da planilha original", () => {
    const csv = [
      "Código do produto;Descrição;Categoria;Fornecedor ;Estoque mínimo;Estoque máximo",
      "1;Adesivo Sicredi;Adesivos;Fornecedor A;100;1000",
    ].join("\n");

    expect(stock.parseProductsCsv(csv, "agora")).toEqual([
      {
        id: "1",
        name: "Adesivo Sicredi",
        category: "Adesivos",
        supplier: "Fornecedor A",
        min_stock: 100,
        max_stock: 1000,
        notes: "",
        adicionado_em: "agora",
        alterado_em: "",
      },
    ]);
  });

  test("importa entradas e saidas com numero brasileiro e data serial", () => {
    const csv = [
      "Código do produto;Produto;Entradas / Saída;Data da movimentação;Quantidade;Valor de compra (unitário);Valor da transação",
      "1;Produto A;Entrada;45741;10;2,50;25,00",
      "1;Produto A;Saída;25/03/2025;3;;",
    ].join("\n");

    const rows = stock.parseMovementsCsv(csv, "agora");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      product_id: "1",
      type: "entrada",
      movement_date: "2025-03-25",
      quantity: 10,
      unit_cost: 2.5,
      total_value: 25,
    });
    expect(rows[1]).toMatchObject({
      product_id: "1",
      type: "saida",
      movement_date: "2025-03-25",
      quantity: 3,
    });
  });

  test("calcula estoque atual, valor medio e situacao por produto", () => {
    const products = [
      { id: "1", name: "Produto A", category: "Cat", min_stock: 5, max_stock: 20 },
      { id: "2", name: "Produto B", category: "Cat", min_stock: 3, max_stock: 8 },
    ];
    const movements = [
      { product_id: "1", type: "entrada", quantity: 10, unit_cost: 2, total_value: 20, movement_date: "2025-01-01" },
      { product_id: "1", type: "saida", quantity: 4, unit_cost: 0, total_value: 0, movement_date: "2025-01-02" },
      { product_id: "2", type: "entrada", quantity: 12, unit_cost: 5, total_value: 60, movement_date: "2025-01-03" },
    ];

    const inventory = stock.buildInventory(products, movements);
    expect(inventory[0]).toMatchObject({
      current_stock: 6,
      entries: 10,
      exits: 4,
      avg_cost: 2,
      stock_value: 12,
      status: "ok",
    });
    expect(inventory[1]).toMatchObject({
      current_stock: 12,
      status: "excess",
    });
  });
});
