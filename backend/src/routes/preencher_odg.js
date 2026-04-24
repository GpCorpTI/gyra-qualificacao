import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Preenche os campos de um arquivo .odg com os dados fornecidos.
 * @param {string} arquivoEntrada - Caminho do .odg template
 * @param {string} arquivoSaida  - Caminho do .odg gerado
 * @param {Object} dados         - { NomeDoCampo: "valor", ... }
 */
function preencherOdg(arquivoEntrada, arquivoSaida, dados) {
  const zip = new AdmZip(arquivoEntrada);
  const entry = zip.getEntry('content.xml');

  if (!entry) throw new Error('content.xml não encontrado no arquivo ODG');

  let content = entry.getData().toString('utf-8');

  for (const [campo, valor] of Object.entries(dados)) {
    const valorXml = String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const paragrafos = valorXml
      .split('\n')
      .map(linha => `<text:p>${linha}</text:p>`)
      .join('');

    const pattern = new RegExp(
      `(<draw:frame [^>]*draw:name="${campo}"[^>]*><draw:text-box>)<text:p/>(</draw:text-box></draw:frame>)`,
      'g'
    );

    content = content.replace(pattern, `$1${paragrafos}$2`);
  }

  zip.updateFile('content.xml', Buffer.from(content, 'utf-8'));
  zip.writeZip(arquivoSaida);
  console.log(`✅ ODG gerado: ${arquivoSaida}`);
}

/**
 * Converte um arquivo .odg para .pdf usando LibreOffice.
 * @param {string} arquivoOdg   - Caminho do .odg a converter
 * @param {string} pastaDestino - Pasta onde o PDF será salvo
 * @returns {string} Caminho do PDF gerado
 */
function converterParaPdf(arquivoOdg, pastaDestino) {
  console.log('🔄 Convertendo para PDF...');

  const possiveisCaminhos = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];

  const soffice = possiveisCaminhos.find(p => fs.existsSync(p));

  if (!soffice) {
    throw new Error(
      'LibreOffice não encontrado. Instale em https://www.libreoffice.org/download/'
    );
  }

  execSync(`"${soffice}" --headless --convert-to pdf "${arquivoOdg}" --outdir "${pastaDestino}"`, {
    stdio: 'inherit',
  });

  const nomePdf = path.basename(arquivoOdg, '.odg') + '.pdf';
  const caminhoPdf = path.join(pastaDestino, nomePdf);

  if (!fs.existsSync(caminhoPdf)) {
    throw new Error(`PDF não foi gerado em: ${caminhoPdf}`);
  }

  console.log(`✅ PDF gerado: ${caminhoPdf}`);
  return caminhoPdf;
}

// ── DADOS PARA PREENCHER ─────────────────────────────────────────────────────
const dados = {
  Nome_Negocio: 'Empresa XPTO Ltda',
  CNPJ_Negocio: '12.345.678/0001-99',
  Data_Consulta: '20/03/2026',
  Resultado_Analise: 'Aprovado',
  Resumo_Empresa: 'Empresa de tecnologia fundada em 2010.\nAtua no setor de software.',
  Pontos_Serasa: '850',
  Restricoes_Negocio: 'Nenhuma restrição encontrada.',
  Reprovacao_Negocio: '—',
  Socio_Negocio: 'João da Silva - 50%\nMaria Souza - 50%',
  Cadastro_Negocio: 'Regular',
  Certidao_Negocio: 'Certidão negativa emitida.',
  Falencias_Negocio: 'Sem ocorrências.',
};

// ── EXECUÇÃO ─────────────────────────────────────────────────────────────────
const entrada = path.resolve(__dirname, 'PDF_MOTOR_textbox.odg');
const saida = path.resolve(__dirname, 'PDF_MOTOR_preenchido.odg');
const pastaDestino = path.resolve(__dirname);

export { preencherOdg, converterParaPdf };

// Executa somente se chamar o arquivo diretamente
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  preencherOdg(entrada, saida, dados);
  converterParaPdf(saida, pastaDestino);
}