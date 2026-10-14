# Logistix360 v3.7.2

## Atualização
Esta versão reúne ajustes solicitados na interface de coletas, chat e exportação Excel.

### Alterações
- Para fornecedores, motivos relacionados a coleta, entrega e transportadora ficam indisponíveis enquanto a carga não tiver sido assumida; a gravação também valida essa regra para impedir envio por caminhos alternativos.
- CIF e FOB explicados nas opções de frete e no filtro de relatórios.
- Destino com nome da empresa/pessoa, endereço, número e complemento opcional; complemento só aparece na composição do endereço quando preenchido.
- Chat da carga não recria o campo de escrita a cada sincronização; rascunhos e posição do cursor são preservados ao atualizar conversas.
- Chat de suporte com respostas rápidas que o suporte pode enviar com um clique.
- Registro de ocorrência com campo obrigatório de motivo principal e descrição detalhada separada.
- Confirmação de coleta bloqueada quando nenhuma transportadora assumiu a carga; o fornecedor não consegue confirmar coleta em uma carga ainda sem transportadora atribuída.
- Excel inclui CNPJ do destinatário, nome do destinatário e complemento de destino; remove preenchimento azul em bloco das linhas de dados e mantém destaque por status.
- Ajuste das fórmulas de totalização para somar somente as linhas de dados, sem incluir a própria linha de total.

## Publicação no Netlify
1. Faça backup da versão atualmente publicada.
2. Publique o conteúdo deste ZIP pelo método de deploy usado no seu site.
3. Preserve as variáveis de ambiente e o armazenamento existente `logistix360-prod`.
4. Não apague nem recrie o armazenamento de dados.
5. Após publicar, valide com uma conta de fornecedor, uma conta de transportadora e uma conta de administrador: cadastro/edição de coleta, chat digitando sem perda de texto, ocorrência, confirmação de coleta e exportação XLSX.

## Observação
O pacote foi verificado quanto à sintaxe JavaScript e integridade do arquivo ZIP. A implantação real no Netlify e testes de navegador com dados de produção não foram executados nesta entrega.
