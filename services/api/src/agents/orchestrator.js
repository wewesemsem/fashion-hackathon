import { analyzeOutfit } from './outfitAgent.js';
import { assessFashionRisks } from './riskAgent.js';
import { proposeAlternative } from './alternativeAgent.js';

function demoPipeline() {
  return {
    detected: {
      items: ['polyester fleece hoodie', 'conventional denim jeans'],
      materialsGuess: ['synthetic polyester', 'cotton-denim blend'],
      scene: 'Casual streetwear outfit on camera (demo mode — add GEMINI_API_KEY)',
      labels: ['clothing', 'hoodie', 'denim', 'jeans'],
      confidence: 0.85,
    },
    overallSeverity: 'medium',
    lifecycleFootprint: {
      primaryStage: 'DYEING, BLEACHING & FINISHING',
      summary: 'Heavy water & chemical footprint from denim dye finishing, plus synthetic microfiber shedding in washing.',
    },
    matrix: {
      wearers: [
        {
          title: 'Synthetic fiber shedding & skin friction',
          severity: 'low',
          detail: 'Polyester fleece blends can shed airborne fibers during wear and retain moisture against sensitive skin.',
          lifecycleStage: 'CONSUMER USE',
          source: {
            agency: 'UNEP',
            citation: 'UNEP Circular Textiles: Consumer synthetic microfiber exposure and shedding',
            url: 'https://www.unep.org/topics/chemicals-and-pollution-action/circularity-sectors/sustainable-and-circular-textiles',
          },
        },
      ],
      workers: [
        {
          title: 'Cotton dust & repetitive sewing strain',
          severity: 'medium',
          detail: 'Denim production involves raw cotton processing (airway risks) and high-speed repetitive sewing postures.',
          lifecycleStage: 'GARMENT MANUFACTURING',
          source: {
            agency: 'OSHA',
            citation: 'OSHA Textiles: Musculoskeletal stresses, awkward posture, and organic dust hazards',
            url: 'https://www.osha.gov/textiles',
          },
        },
        {
          title: 'Denim dye & chemical wet processing',
          severity: 'medium',
          detail: 'Synthesizing and fixing synthetic indigo and finishing agents can expose workers to airborne dust and chemicals.',
          lifecycleStage: 'DYEING, BLEACHING & FINISHING',
          source: {
            agency: 'NIOSH',
            citation: 'CDC/NIOSH HC13: Powder dye handling hazards and occupational respiratory risks',
            url: 'https://www.cdc.gov/niosh/docs/hazardcontrol/hc13.html',
          },
        },
      ],
      planet: [
        {
          title: 'Washing microfiber wastewater pollution',
          severity: 'high',
          detail: 'Synthetic fleece sheds non-biodegradable microfibers during laundering that bypass wastewater treatment.',
          lifecycleStage: 'WASHING',
          source: {
            agency: 'UNEP',
            citation: 'UNEP 2025: Synthetic microplastic pollution in marine and freshwater ecosystems',
            url: 'https://www.unep.org/topics/chemicals-and-pollution-action/circularity-sectors/sustainable-and-circular-textiles',
          },
        },
        {
          title: 'Denim water & climate footprint',
          severity: 'high',
          detail: 'Conventional denim requires intensive water processing and high embodied energy in spinning and synthetic dyeing.',
          lifecycleStage: 'DYEING, BLEACHING & FINISHING',
          source: {
            agency: 'UNEP',
            citation: 'UNEP 2025: Textiles account for 2–8% global GHG emissions and ~86M Olympic pools water annually',
            url: 'https://www.unep.org/annualreport/2025/stories/minimizing-fashions-environmental-footprint',
          },
        },
      ],
    },
    health: [
      {
        severity: 'low',
        title: 'Synthetic fiber shedding & skin friction',
        detail: 'Polyester fleece blends can shed airborne fibers during wear and retain moisture against sensitive skin.',
        source: 'UNEP Circular Textiles',
        sourceUrl: 'https://www.unep.org/topics/chemicals-and-pollution-action/circularity-sectors/sustainable-and-circular-textiles',
      },
    ],
    workerHealth: [
      {
        severity: 'medium',
        title: 'Cotton dust & repetitive sewing strain',
        detail: 'Denim production involves raw cotton processing and high-speed repetitive sewing postures.',
        source: 'OSHA Textiles',
        sourceUrl: 'https://www.osha.gov/textiles',
      },
    ],
    environment: [
      {
        severity: 'high',
        title: 'Microfiber pollution & chemical runoff',
        detail: 'Polyester sheds microfibers during washing; conventional denim requires heavy water and chemical finishing.',
        source: 'UNEP 2025 Footprint',
        sourceUrl: 'https://www.unep.org/annualreport/2025/stories/minimizing-fashions-environmental-footprint',
      },
    ],
    betterChoices: [
      'Opt for GOTS-certified organic cotton or recycled fleece to avoid virgin petroleum synthetics',
      'Wash synthetic garments in a microfiber filtration bag to protect waterways',
      'Choose secondhand or laser-finished denim to reduce chemical wet-processing impacts',
    ],
    alternativeOutfit: {
      title: 'Low-impact circular capsule',
      items: ['GOTS organic cotton loopback hoodie', 'upcycled vintage denim jeans'],
      whyHealthier: 'Breathable unbleached organic cotton eliminates synthetic fiber shedding and minimizes chemical finish exposure.',
      whyGreener: 'Prevents virgin synthetic microplastics, cuts water/dye processing by ~80%, and extends garment circularity.',
      imageUrl: null,
      imagePromptUsed: 'Clean product photo of GOTS organic cotton loopback hoodie and vintage upcycled denim jeans, soft editorial lighting',
    },
    timestamp: new Date().toISOString(),
    demo: true,
  };
}

export async function runFashionPipeline({ imageBase64, mimeType }) {
  if (!process.env.GEMINI_API_KEY) {
    return demoPipeline();
  }

  try {
    const outfit = await analyzeOutfit({ imageBase64, mimeType });
    const risks = await assessFashionRisks(outfit);
    const alternativeOutfit = await proposeAlternative(outfit, risks);

    return {
      detected: {
        items: outfit.items || [],
        materialsGuess: outfit.materialsGuess || [],
        scene: outfit.scene || '',
        labels: outfit.labels || [],
        confidence: outfit.confidence ?? null,
      },
      overallSeverity: risks.overallSeverity || 'medium',
      lifecycleFootprint: risks.lifecycleFootprint || null,
      matrix: risks.matrix || null,
      health: risks.health || (risks.matrix?.wearers || []),
      workerHealth: risks.workerHealth || (risks.matrix?.workers || []),
      environment: risks.environment || (risks.matrix?.planet || []),
      betterChoices: risks.betterChoices || [],
      alternativeOutfit,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Gemini Multi-Agent Error]:', err.message || err);
    const fallback = demoPipeline();
    fallback.fallbackNotice = `Gemini API blocked or unavailable (${err.message || 'API error'}). Showing demo analysis.`;
    return fallback;
  }
}
