import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES = [
  { slug: 'animals', name: 'Động vật' },
  { slug: 'food', name: 'Đồ ăn' },
  { slug: 'household', name: 'Đồ gia dụng' },
  { slug: 'jobs', name: 'Nghề nghiệp' },
  { slug: 'vehicles', name: 'Phương tiện' },
  { slug: 'places', name: 'Địa điểm' },
  { slug: 'activities', name: 'Hoạt động' },
  { slug: 'tech', name: 'Công nghệ' },
  { slug: 'school', name: 'Trường học' },
  { slug: 'nature', name: 'Thiên nhiên' },
];

const WORDS: Array<{ canonical: string; category: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD'; synonyms: string[] }> = [
  { canonical: 'con mèo', category: 'animals', difficulty: 'EASY', synonyms: ['mèo'] },
  { canonical: 'con chó', category: 'animals', difficulty: 'EASY', synonyms: ['chó'] },
  { canonical: 'con cá', category: 'animals', difficulty: 'EASY', synonyms: ['cá'] },
  { canonical: 'con gà', category: 'animals', difficulty: 'EASY', synonyms: ['gà'] },
  { canonical: 'con vịt', category: 'animals', difficulty: 'EASY', synonyms: ['vịt'] },
  { canonical: 'con bò', category: 'animals', difficulty: 'EASY', synonyms: ['bò'] },
  { canonical: 'con heo', category: 'animals', difficulty: 'EASY', synonyms: ['heo', 'con lợn', 'lợn'] },
  { canonical: 'con ngựa', category: 'animals', difficulty: 'EASY', synonyms: ['ngựa'] },
  { canonical: 'con voi', category: 'animals', difficulty: 'EASY', synonyms: ['voi'] },
  { canonical: 'con hổ', category: 'animals', difficulty: 'MEDIUM', synonyms: ['hổ', 'cọp'] },
  { canonical: 'con sư tử', category: 'animals', difficulty: 'MEDIUM', synonyms: ['sư tử'] },
  { canonical: 'con khỉ', category: 'animals', difficulty: 'EASY', synonyms: ['khỉ'] },
  { canonical: 'con rùa', category: 'animals', difficulty: 'EASY', synonyms: ['rùa'] },
  { canonical: 'con rắn', category: 'animals', difficulty: 'EASY', synonyms: ['rắn'] },
  { canonical: 'con chim', category: 'animals', difficulty: 'EASY', synonyms: ['chim'] },
  { canonical: 'con bướm', category: 'animals', difficulty: 'EASY', synonyms: ['bướm'] },
  { canonical: 'con ong', category: 'animals', difficulty: 'EASY', synonyms: ['ong'] },
  { canonical: 'con kiến', category: 'animals', difficulty: 'EASY', synonyms: ['kiến'] },
  { canonical: 'con cá mập', category: 'animals', difficulty: 'MEDIUM', synonyms: ['cá mập'] },
  { canonical: 'con cá heo', category: 'animals', difficulty: 'MEDIUM', synonyms: ['cá heo'] },
  { canonical: 'con gấu trúc', category: 'animals', difficulty: 'MEDIUM', synonyms: ['gấu trúc'] },
  { canonical: 'con kangaroo', category: 'animals', difficulty: 'HARD', synonyms: ['kangaroo'] },
  { canonical: 'con chim cánh cụt', category: 'animals', difficulty: 'HARD', synonyms: ['chim cánh cụt'] },

  { canonical: 'cơm', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'phở', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'bánh mì', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'bún chả', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'bánh xèo', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'gỏi cuốn', category: 'food', difficulty: 'MEDIUM', synonyms: ['nem cuốn'] },
  { canonical: 'bánh chưng', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'bánh tét', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'trà sữa', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'cà phê', category: 'food', difficulty: 'EASY', synonyms: ['cafe'] },
  { canonical: 'sinh tố', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'kem', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'bánh kem', category: 'food', difficulty: 'EASY', synonyms: ['bánh sinh nhật'] },
  { canonical: 'pizza', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'hamburger', category: 'food', difficulty: 'MEDIUM', synonyms: ['bánh mì kẹp'] },
  { canonical: 'sushi', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'mì gói', category: 'food', difficulty: 'EASY', synonyms: ['mì ăn liền', 'mì tôm'] },
  { canonical: 'trứng ốp la', category: 'food', difficulty: 'MEDIUM', synonyms: ['trứng chiên'] },
  { canonical: 'bánh tráng trộn', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'xôi', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'chè', category: 'food', difficulty: 'EASY', synonyms: [] },
  { canonical: 'bánh bông lan', category: 'food', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'tôm hùm', category: 'food', difficulty: 'HARD', synonyms: [] },

  { canonical: 'cái bàn', category: 'household', difficulty: 'EASY', synonyms: ['bàn'] },
  { canonical: 'cái ghế', category: 'household', difficulty: 'EASY', synonyms: ['ghế'] },
  { canonical: 'cái giường', category: 'household', difficulty: 'EASY', synonyms: ['giường'] },
  { canonical: 'tivi', category: 'household', difficulty: 'EASY', synonyms: ['tv'] },
  { canonical: 'tủ lạnh', category: 'household', difficulty: 'EASY', synonyms: [] },
  { canonical: 'máy giặt', category: 'household', difficulty: 'EASY', synonyms: [] },
  { canonical: 'quạt', category: 'household', difficulty: 'EASY', synonyms: ['cái quạt'] },
  { canonical: 'đèn', category: 'household', difficulty: 'EASY', synonyms: ['bóng đèn', 'cái đèn'] },
  { canonical: 'nồi cơm điện', category: 'household', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'bếp ga', category: 'household', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'lò vi sóng', category: 'household', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'máy hút bụi', category: 'household', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'điều hòa', category: 'household', difficulty: 'MEDIUM', synonyms: ['máy lạnh'] },
  { canonical: 'đồng hồ', category: 'household', difficulty: 'EASY', synonyms: ['cái đồng hồ'] },
  { canonical: 'gương', category: 'household', difficulty: 'EASY', synonyms: ['cái gương'] },
  { canonical: 'chén', category: 'household', difficulty: 'EASY', synonyms: ['bát'] },
  { canonical: 'đũa', category: 'household', difficulty: 'EASY', synonyms: [] },
  { canonical: 'cái chảo', category: 'household', difficulty: 'EASY', synonyms: ['chảo'] },
  { canonical: 'máy sấy tóc', category: 'household', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'bàn ủi', category: 'household', difficulty: 'MEDIUM', synonyms: ['bàn là'] },

  { canonical: 'bác sĩ', category: 'jobs', difficulty: 'EASY', synonyms: [] },
  { canonical: 'giáo viên', category: 'jobs', difficulty: 'EASY', synonyms: ['thầy giáo', 'cô giáo'] },
  { canonical: 'công an', category: 'jobs', difficulty: 'EASY', synonyms: ['cảnh sát'] },
  { canonical: 'bộ đội', category: 'jobs', difficulty: 'EASY', synonyms: ['lính'] },
  { canonical: 'nông dân', category: 'jobs', difficulty: 'EASY', synonyms: [] },
  { canonical: 'đầu bếp', category: 'jobs', difficulty: 'EASY', synonyms: [] },
  { canonical: 'lập trình viên', category: 'jobs', difficulty: 'MEDIUM', synonyms: ['developer'] },
  { canonical: 'ca sĩ', category: 'jobs', difficulty: 'EASY', synonyms: [] },
  { canonical: 'diễn viên', category: 'jobs', difficulty: 'EASY', synonyms: [] },
  { canonical: 'họa sĩ', category: 'jobs', difficulty: 'EASY', synonyms: [] },
  { canonical: 'nhà báo', category: 'jobs', difficulty: 'MEDIUM', synonyms: ['phóng viên'] },
  { canonical: 'phi công', category: 'jobs', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'thợ cắt tóc', category: 'jobs', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'luật sư', category: 'jobs', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'kiến trúc sư', category: 'jobs', difficulty: 'HARD', synonyms: [] },

  { canonical: 'xe máy', category: 'vehicles', difficulty: 'EASY', synonyms: ['xe gắn máy'] },
  { canonical: 'xe đạp', category: 'vehicles', difficulty: 'EASY', synonyms: [] },
  { canonical: 'ô tô', category: 'vehicles', difficulty: 'EASY', synonyms: ['xe hơi', 'xe ô tô'] },
  { canonical: 'xe buýt', category: 'vehicles', difficulty: 'EASY', synonyms: ['bus'] },
  { canonical: 'máy bay', category: 'vehicles', difficulty: 'EASY', synonyms: [] },
  { canonical: 'tàu hỏa', category: 'vehicles', difficulty: 'MEDIUM', synonyms: ['xe lửa'] },
  { canonical: 'tàu thủy', category: 'vehicles', difficulty: 'MEDIUM', synonyms: ['thuyền'] },
  { canonical: 'trực thăng', category: 'vehicles', difficulty: 'MEDIUM', synonyms: ['máy bay trực thăng'] },
  { canonical: 'tàu ngầm', category: 'vehicles', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'xe tải', category: 'vehicles', difficulty: 'EASY', synonyms: [] },
  { canonical: 'xe cứu thương', category: 'vehicles', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'xe cứu hỏa', category: 'vehicles', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'tên lửa', category: 'vehicles', difficulty: 'MEDIUM', synonyms: [] },

  { canonical: 'trường học', category: 'places', difficulty: 'EASY', synonyms: ['trường'] },
  { canonical: 'bệnh viện', category: 'places', difficulty: 'EASY', synonyms: [] },
  { canonical: 'chợ', category: 'places', difficulty: 'EASY', synonyms: [] },
  { canonical: 'siêu thị', category: 'places', difficulty: 'EASY', synonyms: [] },
  { canonical: 'công viên', category: 'places', difficulty: 'EASY', synonyms: [] },
  { canonical: 'bãi biển', category: 'places', difficulty: 'EASY', synonyms: [] },
  { canonical: 'sân bay', category: 'places', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'nhà thờ', category: 'places', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'chùa', category: 'places', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'thư viện', category: 'places', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'bảo tàng', category: 'places', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'rạp chiếu phim', category: 'places', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'sân vận động', category: 'places', difficulty: 'MEDIUM', synonyms: [] },

  { canonical: 'đi bộ', category: 'activities', difficulty: 'EASY', synonyms: [] },
  { canonical: 'chạy', category: 'activities', difficulty: 'EASY', synonyms: ['chạy bộ'] },
  { canonical: 'bơi', category: 'activities', difficulty: 'EASY', synonyms: ['bơi lội'] },
  { canonical: 'đá bóng', category: 'activities', difficulty: 'EASY', synonyms: ['chơi bóng đá'] },
  { canonical: 'đọc sách', category: 'activities', difficulty: 'EASY', synonyms: [] },
  { canonical: 'nấu ăn', category: 'activities', difficulty: 'EASY', synonyms: [] },
  { canonical: 'hát', category: 'activities', difficulty: 'EASY', synonyms: ['ca hát'] },
  { canonical: 'nhảy', category: 'activities', difficulty: 'EASY', synonyms: ['khiêu vũ'] },
  { canonical: 'câu cá', category: 'activities', difficulty: 'EASY', synonyms: [] },
  { canonical: 'cắm trại', category: 'activities', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'leo núi', category: 'activities', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'lái xe', category: 'activities', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'chụp ảnh', category: 'activities', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'vẽ tranh', category: 'activities', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'đánh cờ', category: 'activities', difficulty: 'MEDIUM', synonyms: ['chơi cờ'] },
  { canonical: 'tập yoga', category: 'activities', difficulty: 'MEDIUM', synonyms: ['yoga'] },
  { canonical: 'trượt patin', category: 'activities', difficulty: 'HARD', synonyms: [] },

  { canonical: 'điện thoại', category: 'tech', difficulty: 'EASY', synonyms: ['điện thoại di động'] },
  { canonical: 'máy tính', category: 'tech', difficulty: 'EASY', synonyms: ['computer', 'laptop'] },
  { canonical: 'internet', category: 'tech', difficulty: 'EASY', synonyms: ['wifi', 'mạng'] },
  { canonical: 'robot', category: 'tech', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'trí tuệ nhân tạo', category: 'tech', difficulty: 'HARD', synonyms: ['ai'] },
  { canonical: 'drone', category: 'tech', difficulty: 'MEDIUM', synonyms: ['máy bay không người lái'] },
  { canonical: 'kính VR', category: 'tech', difficulty: 'HARD', synonyms: ['thực tế ảo'] },
  { canonical: 'pin', category: 'tech', difficulty: 'EASY', synonyms: [] },
  { canonical: 'camera', category: 'tech', difficulty: 'EASY', synonyms: ['máy ảnh'] },
  { canonical: 'tai nghe', category: 'tech', difficulty: 'EASY', synonyms: [] },

  { canonical: 'cặp sách', category: 'school', difficulty: 'EASY', synonyms: ['ba lô'] },
  { canonical: 'bảng đen', category: 'school', difficulty: 'EASY', synonyms: ['bảng'] },
  { canonical: 'phấn', category: 'school', difficulty: 'EASY', synonyms: ['viên phấn'] },
  { canonical: 'sách giáo khoa', category: 'school', difficulty: 'MEDIUM', synonyms: ['sách'] },
  { canonical: 'bút chì', category: 'school', difficulty: 'EASY', synonyms: [] },
  { canonical: 'tẩy', category: 'school', difficulty: 'EASY', synonyms: ['gôm'] },
  { canonical: 'thước kẻ', category: 'school', difficulty: 'EASY', synonyms: ['thước'] },
  { canonical: 'bài kiểm tra', category: 'school', difficulty: 'MEDIUM', synonyms: ['bài thi'] },
  { canonical: 'bài tập về nhà', category: 'school', difficulty: 'MEDIUM', synonyms: ['homework'] },
  { canonical: 'tốt nghiệp', category: 'school', difficulty: 'MEDIUM', synonyms: [] },

  { canonical: 'mặt trời', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'mặt trăng', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'sao', category: 'nature', difficulty: 'EASY', synonyms: ['ngôi sao'] },
  { canonical: 'mây', category: 'nature', difficulty: 'EASY', synonyms: ['đám mây'] },
  { canonical: 'mưa', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'cầu vồng', category: 'nature', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'sấm sét', category: 'nature', difficulty: 'MEDIUM', synonyms: ['sét'] },
  { canonical: 'tuyết', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'núi', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'sông', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'biển', category: 'nature', difficulty: 'EASY', synonyms: ['đại dương'] },
  { canonical: 'rừng', category: 'nature', difficulty: 'EASY', synonyms: [] },
  { canonical: 'hoa', category: 'nature', difficulty: 'EASY', synonyms: ['bông hoa'] },
  { canonical: 'cây', category: 'nature', difficulty: 'EASY', synonyms: ['cái cây'] },
  { canonical: 'núi lửa', category: 'nature', difficulty: 'MEDIUM', synonyms: [] },
  { canonical: 'thác nước', category: 'nature', difficulty: 'MEDIUM', synonyms: ['thác'] },
  { canonical: 'động đất', category: 'nature', difficulty: 'HARD', synonyms: [] },
  { canonical: 'sóng thần', category: 'nature', difficulty: 'HARD', synonyms: ['tsunami'] },
  { canonical: 'bắc cực quang', category: 'nature', difficulty: 'HARD', synonyms: ['cực quang'] },
];

async function main() {
  console.log('Seeding database...');

  const categoryMap = new Map<string, string>();
  for (const cat of CATEGORIES) {
    const created = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: { name: cat.name },
      create: cat,
    });
    categoryMap.set(cat.slug, created.id);
  }

  let wordCount = 0;
  for (const w of WORDS) {
    const categoryId = categoryMap.get(w.category);
    if (!categoryId) continue;
    await prisma.word.upsert({
      where: { canonical: w.canonical },
      update: { categoryId, difficulty: w.difficulty, synonyms: w.synonyms },
      create: {
        canonical: w.canonical,
        categoryId,
        difficulty: w.difficulty,
        synonyms: w.synonyms,
        active: true,
      },
    });
    wordCount++;
  }

  console.log(`Seeded ${CATEGORIES.length} categories and ${wordCount} words`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
