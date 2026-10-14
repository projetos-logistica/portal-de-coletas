# Logistix360 — ambiente local de testes (v3.7.2)

Este pacote permite executar o site no computador usando o Netlify CLI, inclusive as Netlify Functions da API. Ele **não é um serviço de hospedagem pública**: enquanto estiver rodando, o endereço local funciona no próprio PC e, com configuração de rede/firewall, em outros dispositivos da mesma rede. Para acesso público pela internet, use Netlify ou configure um túnel seguro separadamente.

## Requisitos
- Windows 10/11
- Node.js LTS instalado: https://nodejs.org/
- Internet na primeira execução para instalar as dependências

## Iniciar
1. Extraia o ZIP para uma pasta comum, por exemplo `C:\Logistix360-Testes`.
2. Instale o Node.js LTS se ainda não estiver instalado.
3. Dê dois cliques em `INICIAR_LOGISTIX360.bat`.
4. Na primeira execução, aguarde a instalação. Depois abra `http://localhost:8888`.
5. Para manter o site disponível, deixe a janela do servidor aberta e o PC ligado. `Ctrl+C` encerra o servidor.

## Contas locais de demonstração
- Administrador: `admin@logistix.com` / `AdminLocal@123`
- Fornecedor: `fornecedor@empresa.com` / `FornLocal@123`
- Transportadora: `brasspress@logistix.com` / `BrassLocal@123`

Troque essas senhas antes de expor o ambiente a qualquer outra pessoa.

## Isolamento de dados
O ambiente define `LOGISTIX_BLOBS_STORE=logistix360-local` para separar os dados de teste do nome do armazenamento de produção `logistix360-prod`. A aplicação foi adaptada para ler o nome do store dessa variável. O comportamento de armazenamento local depende do suporte do Netlify CLI/Netlify Blobs na versão instalada. Se a API mostrar erro de Blobs, não configure credenciais do site de produção nesse ambiente; confira a mensagem no terminal.

## Acesso por outro dispositivo na mesma rede
O servidor inicia escutando em `0.0.0.0`. No outro dispositivo, use o IPv4 do PC seguido de `:8888` (ex.: `http://192.168.1.20:8888`) e permita o acesso no Firewall do Windows apenas em rede privada. O IP varia por rede.

## Observações
- Não apague nem recrie o armazenamento de produção.
- Esta é uma ferramenta de desenvolvimento/testes, não substitui a publicação oficial.
- A inicialização requer download de pacotes npm.
